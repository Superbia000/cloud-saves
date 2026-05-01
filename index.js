const fs = require('fs').promises;
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const simpleGit = require('simple-git');

let fetch;
try {
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        fetch = require('node-fetch');
    });
} catch (error) {
    console.error('无法导入node-fetch:', error);
    fetch = async (url, options) => {
        const https = require('https');
        const http = require('http');
        return new Promise((resolve, reject) => {
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: async () => JSON.parse(data)
                    });
                });
            });
            req.on('error', reject);
            if (options && options.body) req.write(options.body);
            req.end();
        });
    };
}

const info = {
    id: 'cloud-saves',
    name: 'Cloud Saves',
    description: '通过GitHub仓库创建、管理和恢复SillyTavern的云端存档。',
    version: '1.0.0',
};

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_DIR = path.join(process.cwd(), 'data');
const DEFAULT_BRANCH = 'main';

const DEFAULT_CONFIG = {
    repo_url: '',
    branch: DEFAULT_BRANCH,
    username: '',
    github_token: '',
    display_name: '',
    is_authorized: false,
    last_save: null,
    current_save: null,
    has_temp_stash: false,
    autoSaveEnabled: false,
    autoSaveInterval: 30,
    autoSaveTargetTag: '',
};

let currentOperation = null;
let autoSaveBackendTimer = null;

async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        config.branch = config.branch || DEFAULT_BRANCH;
        config.autoSaveEnabled = config.autoSaveEnabled === undefined ? DEFAULT_CONFIG.autoSaveEnabled : config.autoSaveEnabled;
        config.autoSaveInterval = config.autoSaveInterval === undefined ? DEFAULT_CONFIG.autoSaveInterval : config.autoSaveInterval;
        config.autoSaveTargetTag = config.autoSaveTargetTag === undefined ? DEFAULT_CONFIG.autoSaveTargetTag : config.autoSaveTargetTag;
        return config;
    } catch (error) {
        console.warn('Failed to read or parse config, creating default:', error.message);
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// 確保 .gitignore 中包含隱藏的 .git 名稱，避免將巢狀 Git 操作紀錄推上 GitHub
async function ensureGitignoreHidden() {
    const gitignorePath = path.join(DATA_DIR, '.gitignore');
    try {
        let content = '';
        try { content = await fs.readFile(gitignorePath, 'utf8'); } catch(e){}
        if (!content.includes('.git_cloud_hidden')) {
            if (content && !content.endsWith('\n')) content += '\n';
            content += '.git_cloud_hidden\n';
            await fs.writeFile(gitignorePath, content, 'utf8');
            console.log(`[cloud-saves] 自動在 .gitignore 加入了 .git_cloud_hidden`);
        }
    } catch(e) {
        console.error(`[cloud-saves] 更新 .gitignore 失敗:`, e);
    }
}

// 暫時將子資料夾(.git)偽裝，這樣 Git 就不會將其作為 Submodule，而是加入裡面所有的原始碼檔案
async function maskNestedGit(targetPath) {
    const maskedPaths = [];
    try {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(targetPath, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === '.git') {
                    const hiddenPath = path.join(targetPath, '.git_cloud_hidden');
                    try {
                        await fs.rename(entryPath, hiddenPath);
                        maskedPaths.push({ original: entryPath, hidden: hiddenPath });
                    } catch (e) {
                        console.error(`[cloud-saves] 無法偽裝 ${entryPath}:`, e);
                    }
                } else if (entry.name !== '.git_cloud_hidden') {
                    const subMasked = await maskNestedGit(entryPath);
                    maskedPaths.push(...subMasked);
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[cloud-saves] 遞迴偽裝 .git 資料夾時發生錯誤 (${targetPath}):`, error);
        }
    }
    return maskedPaths;
}

// 在操作完成後將其還原為真正的 .git 資料夾
async function unmaskNestedGit(maskedPaths) {
    for (const paths of maskedPaths) {
        try {
            await fs.rename(paths.hidden, paths.original);
        } catch (e) {
            console.error(`[cloud-saves] 無法還原 ${paths.hidden}:`, e);
        }
    }
}

// 從 index 緩存中清除可能早已留下的 Gitlink 舊參照（使得重新索引能以實際檔案型態備份）
async function removeGitlinksFromIndex(git, prefix) {
    console.log(`[cloud-saves] 正在檢查是否有舊 Gitlink 參照: ${prefix}`);
    const prefixPath = prefix.endsWith('/') ? prefix : prefix + '/';

    try {
        const lsFilesOutput = await git.raw('ls-files', '--stage');
        if (!lsFilesOutput) return;

        const lines = lsFilesOutput.trim().split('\n');
        const gitlinksToRemove = [];

        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                const mode = parts[0];
                const filePath = parts.slice(3).join(' ');
                if (mode === '160000' && filePath.startsWith(prefixPath)) {
                    gitlinksToRemove.push(filePath);
                }
            }
        }

        if (gitlinksToRemove.length > 0) {
            console.log(`[cloud-saves] 正在移除 ${gitlinksToRemove.length} 個擴展 Gitlink，改為完整追蹤實體檔案...`);
            for (const filePath of gitlinksToRemove) {
                try {
                     await git.raw('rm', '--cached', '--ignore-unmatch', filePath);
                } catch (rmError) {}
            }
        }
    } catch (error) {
        console.error(`[cloud-saves] 修正 Gitlink 時發生錯誤:`, error);
    }
}

async function getGitInstance(cwd = DATA_DIR) {
    const options = {
        baseDir: cwd,
        binary: 'git',
        maxConcurrentProcesses: 6,
    };
    const git = simpleGit(options);
    const config = await readConfig();

    if (cwd === DATA_DIR && config.repo_url && config.github_token) {
        try {
            const remotes = await git.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            const originalUrl = config.repo_url;
            let authUrl = originalUrl;

            if (originalUrl.startsWith('https://') && !originalUrl.includes('@')) {
                authUrl = originalUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
            }
            if (origin && origin.refs.push !== authUrl) {
                 await git.remote(['set-url', 'origin', authUrl]);
            } else if (!origin && originalUrl) {
                 await git.addRemote('origin', authUrl);
            }
        } catch (error) {
            console.warn(`[cloud-saves] 無法配置授權遠端 URL:`, error.message);
        }
    }
    
    return git;
}

function handleGitError(error, operation = 'Git operation') {
    console.error(`[cloud-saves] ${operation} failed:`, error.message);
    return {
        success: false,
        message: `${operation} failed`,
        details: error.message || error.stack || 'Unknown simple-git error',
        error: error
    };
}

async function isGitInitialized() {
    try {
        const git = simpleGit(DATA_DIR);
        const gitDir = path.join(DATA_DIR, '.git');
        try {
           await fs.access(gitDir);
        } catch {
           return false;
        }
        return await git.checkIsRepo();
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error("[cloud-saves] 檢查 git 初始化發生錯誤:", error);
        }
        return false;
    }
}

async function addGitkeepRecursively(directory) {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        let hasGitkeep = false;
        const subDirectories = [];

        for (const entry of entries) {
            if (entry.isFile() && entry.name === '.gitkeep') {
                hasGitkeep = true;
            }
            if (entry.isDirectory()) {
                if (entry.name !== '.git') {
                    subDirectories.push(path.join(directory, entry.name));
                }
            }
        }

        if (!hasGitkeep) {
            const gitkeepPath = path.join(directory, '.gitkeep');
            try {
                await fs.access(gitkeepPath);
            } catch (e) {
                try {
                    await fs.writeFile(gitkeepPath, '');
                } catch (writeError) {}
            }
        }

        for (const subDir of subDirectories) {
            await addGitkeepRecursively(subDir);
        }
    } catch (error) {}
}

async function initGitRepo() {
    if (await isGitInitialized()) {
        console.log('[cloud-saves] Git repository already initialized in data directory.');
        await ensureGitignoreHidden();
        return { success: true, message: 'Git倉庫已在data目錄中初始化' };
    }

    console.log('[cloud-saves] 正在data目錄中初始化Git倉庫:', DATA_DIR);
    try {
        const git = simpleGit(DATA_DIR);
        await git.init();
        console.log('[cloud-saves] git init 成功');

        console.log('[cloud-saves] Adding .gitkeep files to ensure all directory tracking...');
        await addGitkeepRecursively(DATA_DIR);

        try {
            const gitignorePath = path.join(DATA_DIR, '.gitignore');
            const gitignoreContent = "# Ensure data directory contents are tracked, overriding parent ignores.\n!*\n\n# Ignore specific subdirectories within data\n_uploads/\n_cache/\n_storage/\n_webpack/\n.git_cloud_hidden\n";
            await fs.writeFile(gitignorePath, gitignoreContent, 'utf8');
            console.log(`[cloud-saves] 已成功創建主 ${gitignorePath}`);
        } catch (gitignoreError) {
            console.error(`[cloud-saves] 創建主 .gitignore 文件失敗:`, gitignoreError);
        }

        return { success: true, message: 'Git倉庫初始化成功，並添加了.gitkeep文件' };
    } catch (error) {
        return handleGitError(error, '初始化Git仓库');
    }
}

async function configureRemote(repoUrl) {
    try {
        const git = await getGitInstance();
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        
        let authUrl = repoUrl;
        const config = await readConfig();
        if (repoUrl.startsWith('https://') && config.github_token && !repoUrl.includes('@')) {
            authUrl = repoUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
        }

        if (origin) {
            if (origin.refs.push !== authUrl) {
                await git.remote(['set-url', 'origin', authUrl]);
            }
        } else {
            await git.addRemote('origin', authUrl);
        }
        return { success: true, message: '远程仓库配置成功' };
    } catch (error) {
        return handleGitError(error, '配置远程仓库');
    }
}

async function createSave(name, description) {
    try {
        currentOperation = 'create_save';
        console.log(`[cloud-saves] 正在創建新存檔: ${name}, 描述: ${description}`);
        await ensureGitignoreHidden();
        const config = await readConfig();
        const git = await getGitInstance();
        const branchToPush = config.branch || DEFAULT_BRANCH;

        const encodedName = Buffer.from(name).toString('base64url');
        const tagName = `save_${Date.now()}_${encodedName}`;
        const nowTimestamp = new Date().toISOString();
        const tagMessage = description || `存档: ${name}`;
        const fullTagMessage = `${tagMessage}\nLast Updated: ${nowTimestamp}`;

        const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
        let maskedPaths = [];
        let commitNeeded = false;

        try {
            maskedPaths = await maskNestedGit(extensionsPath);
            await removeGitlinksFromIndex(git, 'default-user/extensions/');

            await git.add('.');
            const status = await git.status();
            commitNeeded = !status.isClean();

            if (commitNeeded) {
                console.log('[cloud-saves] 已掃描完成，執行提交...');
                try {
                    await git.commit(`存档: ${name}`);
                } catch (commitError) {
                    if (commitError.message.includes('nothing to commit')) {
                         commitNeeded = false;
                    } else {
                        throw commitError;
                    }
                }
            }
        } finally {
            await unmaskNestedGit(maskedPaths);
        }

        console.log('[cloud-saves] 創建標籤並推送...');
        await git.addAnnotatedTag(tagName, fullTagMessage);

        const currentBranchStatus = await git.branch();
        const currentBranch = currentBranchStatus.current;

        if (commitNeeded && currentBranch === branchToPush && !currentBranchStatus.detached) {
            try {
                 await git.push('origin', currentBranch);
            } catch (pushError) {
                console.warn(`[cloud-saves] 推送分支錯誤:`, pushError.message);
            }
        }

        await git.push(['origin', tagName]);

        config.last_save = {
            name: name,
            tag: tagName,
            timestamp: nowTimestamp,
            description: description || ''
        };
        await saveConfig(config);

        return {
            success: true,
            message: '存档创建成功',
            saveData: {
                ...config.last_save,
                name: name,
                createdAt: nowTimestamp,
                updatedAt: nowTimestamp
            }
        };
    } catch (error) {
        return handleGitError(error, `创建存档 ${name}`);
    } finally {
        currentOperation = null;
    }
}

async function listSaves() {
    try {
        currentOperation = 'list_saves';
        console.log('[cloud-saves] 获取存档列表');
        const git = await getGitInstance();

        // 1. 使用 ls-remote 獲取當前遠端倉庫的「真實標籤清單」
        console.log('[cloud-saves] Fetching remote tags list via ls-remote...');
        let lsRemoteOutput = '';
        try {
            lsRemoteOutput = await git.listRemote(['--tags', 'origin']);
        } catch (remoteErr) {
            console.warn('[cloud-saves] 無法訪問遠端倉庫，可能是尚未初始化完成。', remoteErr.message);
        }
        
        const remoteTags = new Set();
        if (lsRemoteOutput) {
            const lines = lsRemoteOutput.trim().split('\n');
            for (const line of lines) {
                if (!line) continue;
                // 過濾出 save_ 開頭的標籤，並忽略 Git 特有的 ^{} 指標後綴
                const match = line.match(/refs\/tags\/(save_[^\s\^]+)/);
                if (match) {
                    remoteTags.add(match[1]);
                }
            }
        }

        // 2. 清理本地殘留：找出本地所有的 save_ 標籤，把「不在當前遠端倉庫」的直接刪除
        const localTagsSummary = await git.tags(['-l', 'save_*']);
        const localTags = localTagsSummary.all || [];
        let prunedCount = 0;
        for (const localTag of localTags) {
            if (!remoteTags.has(localTag)) {
                try {
                    await git.tag(['-d', localTag]);
                    prunedCount++;
                } catch(e) {}
            }
        }
        if (prunedCount > 0) {
            console.log(`[cloud-saves] 已清理 ${prunedCount} 個不屬於當前遠端倉庫的本地殘留存檔(標籤)。`);
        }

        // 3. 從遠端拉取最新的標籤資料到本地 (以獲取註解內容和日期)
        console.log('[cloud-saves] Fetching tags data from remote...');
        try {
            await git.fetch(['origin', '--tags', '--force']);
        } catch (fetchErr) {
            console.warn('[cloud-saves] 拉取標籤時出現警告，如果是空倉庫則為正常現象。');
        }

        const formatString = "%(refname:short)%00%(creatordate:iso)%00%(taggername)%00%(subject)%00%(contents)";
        const tagOutput = await git.raw('tag', '-l', 'save_*', '--sort=-creatordate', `--format=${formatString}`);

        if (!tagOutput) return { success: true, saves: [] };

        const saves = tagOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\0');
            if (parts.length < 5) return null;

            const tagName = parts[0];
            
            // 【二次保險過濾】確保返回的標籤確實在遠端的清單中
            if (!remoteTags.has(tagName)) return null;

            const createdAt = new Date(parts[1]).toISOString();
            const taggerName = parts[2] || '未知';
            const subject = parts[3];
            const body = parts[4] || '';

            let name = tagName;
            let description = subject;
            let updatedAt = createdAt;

            const bodyLines = body.split('\n');
            const lastUpdatedLine = bodyLines.find(l => l.startsWith('Last Updated:'));
            if (lastUpdatedLine) {
                const timestampStr = lastUpdatedLine.replace('Last Updated:', '').trim();
                const parsedDate = new Date(timestampStr);
                if (!isNaN(parsedDate)) {
                    updatedAt = parsedDate.toISOString();
                }
            } else {
                description = subject;
            }
            
            const tagNameMatch = tagName.match(/^save_\d+_(.+)$/);
            if (tagNameMatch) {
                try {
                    const encodedName = tagNameMatch[1];
                    name = Buffer.from(encodedName, 'base64url').toString('utf8');
                } catch (decodeError) {
                    name = tagNameMatch[1];
                }
            }

            return {
                name: name,
                tag: tagName,
                commit: null,
                createdAt: createdAt,
                updatedAt: updatedAt,
                description: description.trim(),
                creator: taggerName
            };
        }).filter(Boolean);

        return { success: true, saves: saves };
    } catch (error) {
        return handleGitError(error, '获取存档列表');
    } finally {
        currentOperation = null;
    }
}

// 新增：用於在 Git Checkout 讀取完畢後，不僅還原被拉下來的擴展 .git 資訊，同時進行 Git 骨架修復
async function restoreCheckoutGit(targetPath) {
    try {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(targetPath, entry.name);
            if (entry.isDirectory()) {
                // 如果抓到了從雲端死灰復燃的隱藏 Git 檔案夾
                if (entry.name === '.git_cloud_hidden') {
                    const originalGit = path.join(targetPath, '.git');
                    try {
                        // 1. 確保目標是乾淨的，先強制移除可能衝突的損壞 .git
                        await fs.rm(originalGit, { recursive: true, force: true }).catch(() => {});
                        
                        // 2. 把從存檔拉下來的隱藏檔改回正統的 .git
                        await fs.rename(entryPath, originalGit);
                        
                        // 3. 【核心修復機制】手動補齊 Git 運作所需的基礎空目錄！
                        // 因為 Git 存檔時「不記錄空資料夾」，這會導致還原出來的 .git 壞掉
                        // 把這些空目錄建回來，Git 就會重新承認這是一個正常的倉庫，SillyTavern 就能更新了
                        const requiredGitDirs = [
                            'objects/info',
                            'objects/pack',
                            'refs/heads',
                            'refs/tags',
                            'branches',
                            'info'
                        ];
                        for (const dirName of requiredGitDirs) {
                            await fs.mkdir(path.join(originalGit, dirName), { recursive: true }).catch(() => {});
                        }
                        
                        console.log(`[cloud-saves] 成功修復並還原被刪除擴展的 Git 資訊: ${targetPath}`);
                    } catch (e) {
                        console.error(`[cloud-saves] 無法還原/修復隱藏的 git 目錄 ${entryPath}:`, e);
                    }
                } else if (entry.name !== '.git') {
                    // 只要不是 .git，就繼續往下層資料夾遞迴探查
                    await restoreCheckoutGit(entryPath);
                }
            }
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error(`[cloud-saves] 掃描還原 .git_cloud_hidden 時發生錯誤 (${targetPath}):`, error);
        }
    }
}

// 完整版 loadSave，確保呼叫了上述修復機制
async function loadSave(tagName) {
    try {
        currentOperation = 'load_save';
        console.log(`[cloud-saves] 正在載入存檔: ${tagName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        await git.fetch(['origin', '--tags']);
        const tags = await git.tags(['-l', tagName]);
        if (!tags || !tags.all.includes(tagName)) {
            return { success: false, message: '找不到指定的存档标签' };
        }

        const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
        let maskedPaths = [];
        let stashCreated = false;

        try {
            // 切換前，先保護現有的 .git
            maskedPaths = await maskNestedGit(extensionsPath);

            const status = await git.status();
            if (!status.isClean()) {
                console.log('[cloud-saves] 检测到未保存的更改，在回档前创建临时保存点');
                const stashResult = await git.stash(['push', '-u', '-m', 'Temporary stash before loading save']);
                stashCreated = stashResult && !stashResult.includes('No local changes to save');
                config.has_temp_stash = stashCreated;
            } else {
                config.has_temp_stash = false;
            }
            
            const commit = await git.revparse([tagName]);
            if (!commit) {
                if (stashCreated) await git.stash(['pop']);
                return { success: false, message: '获取存档提交哈希失败' };
            }

            // 這一步會向本地釋放原本已經刪除的擴充（帶有不完整的 .git_cloud_hidden）
            await git.checkout(commit);

        } finally {
            // 1. 還原本來就持續存在的擴展
            await unmaskNestedGit(maskedPaths);
            
            // 2. 地毯式補救措施與 Git 骨架修復：抓出所有從存檔復原的幽靈擴展並修復它們
            await restoreCheckoutGit(extensionsPath); 
        }

        config.current_save = {
            tag: tagName,
            loaded_at: new Date().toISOString()
        };
        await saveConfig(config);

        return {
            success: true,
            message: '存档加载成功',
            stashCreated: stashCreated
        };

    } catch (error) {
        console.error(`[cloud-saves] 載入存檔時發生錯誤:`, error.message);
        try {
            const cfg = await readConfig();
            if (cfg.has_temp_stash) {
                const git = await getGitInstance();
                await git.stash(['pop']);
                cfg.has_temp_stash = false;
                await saveConfig(cfg);
            }
        } catch (recoverError) {
            console.error('[cloud-saves] 錯誤恢復失敗:', recoverError.message);
        }
        
        return { success: false, message: '加载存档失败', details: error.message };
        
    } finally {
        currentOperation = null;
    }
}
async function deleteSave(tagName) {
    try {
        currentOperation = 'delete_save';
        console.log(`[cloud-saves] 正在删除存档: ${tagName}`);
        const git = await getGitInstance();

        await git.tag(['-d', tagName]);
        
        try {
            await git.push(['origin', `:refs/tags/${tagName}`]);
        } catch (pushError) {
            if (!pushError.message.includes('remote ref does not exist') && !pushError.message.includes('deletion of') ) {
                 const config = await readConfig();
                 if (config.current_save && config.current_save.tag === tagName) {
                     config.current_save = null;
                     await saveConfig(config);
                 }
                 return {
                     success: true,
                     message: '本地存档已删除，但删除远程存档失败，可能是网络问题或权限问题',
                     warning: true,
                     details: pushError.message
                 };
            }
        }

        const config = await readConfig();
        if (config.current_save && config.current_save.tag === tagName) {
            config.current_save = null;
            await saveConfig(config);
        }

        return { success: true, message: '存档删除成功' };
    } catch (error) {
        return handleGitError(error, `删除存档 ${tagName}`);
    } finally {
        currentOperation = null;
    }
}

async function renameSave(oldTagName, newName, description) {
    try {
        currentOperation = 'rename_save';
        console.log(`[cloud-saves] 正在重命名存档: ${oldTagName} -> ${newName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        const tags = await git.tags(['-l', oldTagName]);
         if (!tags || !tags.all.includes(oldTagName)) {
             return { success: false, message: '找不到指定的存档标签' };
         }
        const commit = await git.revparse([oldTagName]);
        if (!commit) return { success: false, message: '获取存档提交失败' };

        let oldDecodedName = oldTagName;
        const oldNameMatch = oldTagName.match(/^save_\d+_(.+)$/);
        if (oldNameMatch) {
            try { oldDecodedName = Buffer.from(oldNameMatch[1], 'base64url').toString('utf8'); } catch (e) { /* ignore */ }
        }

        const nowTimestamp = new Date().toISOString();
        const newDescription = description || `存档: ${newName}`;
        const fullNewMessage = `${newDescription}\nLast Updated: ${nowTimestamp}`;

        if (oldDecodedName === newName) {
            await git.tag(['-a', '-f', oldTagName, '-m', fullNewMessage, commit]);
            await git.push(['origin', oldTagName, '--force']);
             return { success: true, message: '存档描述和更新时间已更新', oldTag: oldTagName, newTag: oldTagName, newName: newName };
        } else {
             const encodedNewName = Buffer.from(newName).toString('base64url');
             const newTagName = `save_${Date.now()}_${encodedNewName}`;

             await git.addAnnotatedTag(newTagName, fullNewMessage, commit);
             try {
                await git.push('origin', newTagName);
             } catch (pushError) {
                  await git.tag(['-d', newTagName]);
                  throw pushError;
             }

             await git.tag(['-d', oldTagName]);
             try {
                 await git.push(['origin', `:refs/tags/${oldTagName}`]);
             } catch (e) {}

            if (config.current_save && config.current_save.tag === oldTagName) {
                config.current_save.tag = newTagName;
                await saveConfig(config);
            }

            return { success: true, message: '存档重命名成功', oldTag: oldTagName, newTag: newTagName, newName: newName };
        }
    } catch (error) {
        return handleGitError(error, `重命名存档 ${oldTagName} -> ${newName}`);
    } finally {
        currentOperation = null;
    }
}

async function getSaveDiff(ref1, ref2) {
    try {
        currentOperation = 'get_save_diff';
        const git = simpleGit(DATA_DIR);
        const emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

        try {
            await git.revparse(['--verify', ref1]);
        } catch (error) {
            if ((ref1.endsWith('^') || ref1.endsWith('~1')) && error.message.includes('unknown revision')) {
                ref1 = emptyTreeHash;
            } else if (ref1 === emptyTreeHash) {
                
            } else {
                 return { success: false, message: `找不到或无效的引用: ${ref1}`, details: error.message };
            }
        }
        try {
            await git.revparse(['--verify', ref2]);
        } catch (error) {
             return { success: false, message: `找不到或无效的引用: ${ref2}`, details: error.message };
        }

        let diffOutput;
         try {
             if (ref1 === emptyTreeHash) {
                 const lsTreeOutput = await git.raw('ls-tree', '-r', '--name-only', ref2);
                 if (!lsTreeOutput) return { success: true, changedFiles: [] };
                 changedFiles = lsTreeOutput.trim().split('\n').filter(Boolean).map(fileName => ({
                     status: 'A',
                     fileName: fileName
                 }));
                 return { success: true, changedFiles: changedFiles };
             } else {
                 diffOutput = await git.diff(['--name-status', ref1, ref2]);
             }
         } catch (diffError) {
              return handleGitError(diffError, `获取差异 ${ref1} <-> ${ref2}`);
         }

        const changedFiles = diffOutput.trim().split('\n')
            .filter(Boolean)
            .map(line => {
                const [status, ...fileParts] = line.split(/\s+/);
                const fileName = fileParts.join(' ');
                return { status, fileName };
            });

        return {
            success: true,
            changedFiles: changedFiles
        };
    } catch (error) {
        return handleGitError(error, `获取存档差异 ${ref1} <-> ${ref2}`);
    } finally {
        currentOperation = null;
    }
}

async function getGitStatus() {
    try {
        const git = simpleGit(DATA_DIR);
        const isInitialized = await isGitInitialized();

        let status = null;
        if (isInitialized) {
            if (!currentOperation) { // 防止與備份時的 Mask 衝突
                const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
                let maskedPaths = await maskNestedGit(extensionsPath);
                try {
                    status = await git.status();
                } finally {
                    await unmaskNestedGit(maskedPaths);
                }
            } else {
                status = await git.status();
            }
        }

        let currentBranch = null;
        let isDetached = false;
        if (isInitialized) {
             try {
                 const branchSummary = await git.branch();
                 currentBranch = branchSummary.current;
                 isDetached = branchSummary.detached;
             } catch (branchError) {}
        }

        const config = await readConfig();
        const currentSave = config.current_save;

        const formattedStatus = {
             initialized: isInitialized,
             changes: status ? status.files.map(f => `${f.working_dir}${f.index} ${f.path}`) : [],
             currentBranch: isDetached ? null : currentBranch,
             currentSave: currentSave,
             isDetached: isDetached,
             ahead: status ? status.ahead : 0,
             behind: status ? status.behind : 0,
        };
        
        return formattedStatus;
    } catch (error) {
        throw handleGitError(error, '获取Git状态');
    }
}

async function hasUnsavedChanges() {
    try {
        const git = simpleGit(DATA_DIR);
        if (!await isGitInitialized()) return false;

        let isClean = true;
        if (!currentOperation) {
            const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
            let maskedPaths = await maskNestedGit(extensionsPath);
            try {
                const status = await git.status();
                isClean = status.isClean();
            } finally {
                await unmaskNestedGit(maskedPaths);
            }
        } else {
            const status = await git.status();
            isClean = status.isClean();
        }
        return !isClean;
    } catch (error) {
         return false;
    }
}

async function checkTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) return { exists: false };

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        if (stashList.total === 0) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { exists: false };
        }
        const tempStash = stashList.all.find(s => s.message.includes('Temporary stash before loading save'));
         if (!tempStash) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { exists: false };
         }

        return { exists: true };
    } catch (error) {
        return { exists: config.has_temp_stash };
    }
}

async function applyTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        const stashIndex = stashList.all.findIndex(s => s.message && s.message.includes(stashMessageToFind));

        if (stashIndex === -1) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: false, message: `Stash not found in list` };
        }

        const stashRef = `stash@{${stashIndex}}`;
        await git.stash(['apply', stashRef]);

        try {
            await git.stash(['drop', stashRef]);
        } catch (dropError) {}

        config.has_temp_stash = false;
        await saveConfig(config);

        return { success: true, message: 'Temporary stash applied and dropped successfully' };
    } catch (error) {
        return handleGitError(error, '应用临时Stash');
    }
}

async function discardTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        const stashIndex = stashList.all.findIndex(s => s.message && s.message.includes(stashMessageToFind));

        if (stashIndex === -1) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: true, message: `Stash already gone` };
        }

        const stashRef = `stash@{${stashIndex}}`;
        await git.stash(['drop', stashRef]);

        config.has_temp_stash = false;
        await saveConfig(config);

        return { success: true, message: 'Temporary stash discarded' };
    } catch (error) {
        return handleGitError(error, '丢弃临时Stash');
    }
}

async function performAutoSave() {
    if (currentOperation) return;
    currentOperation = 'auto_save';
    
    let config;
    let git;
    try {
        config = await readConfig();
        if (!config.is_authorized || !config.autoSaveEnabled || !config.autoSaveTargetTag) {
            currentOperation = null;
            return;
        }

        const targetTag = config.autoSaveTargetTag;
        console.log(`[Cloud Saves Auto] 开始自动覆盖存档到: ${targetTag}`);
        git = await getGitInstance();
        const branchToUse = config.branch || DEFAULT_BRANCH;

        let originalDescription = `Auto Save Overwrite: ${targetTag}`;
        try {
             const tagInfoRaw = await git.raw('tag', '-n1', '-l', targetTag, '--format=%(contents)');
             if (tagInfoRaw) originalDescription = tagInfoRaw.trim().split('\n')[0];
        } catch (tagInfoError) {}

        await ensureGitignoreHidden();
        const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
        let maskedPaths = [];
        let newCommitHash;

        try {
            maskedPaths = await maskNestedGit(extensionsPath);
            await removeGitlinksFromIndex(git, 'default-user/extensions/');

            await git.add('.');
            const status = await git.status();
            const hasChanges = !status.isClean();

            if (hasChanges) {
                const commitMessage = `Auto Save Overwrite: ${targetTag}`;
                try {
                    const commitResult = await git.commit(commitMessage);
                     newCommitHash = commitResult.commit;
                    try { await git.push('origin', branchToUse); } catch (pushCommitError) {}
                } catch (commitError) {
                    if (commitError.message.includes('nothing to commit')) {
                        newCommitHash = await git.revparse('HEAD');
                    } else throw commitError;
                }
            } else {
                newCommitHash = await git.revparse('HEAD');
            }
        } finally {
            await unmaskNestedGit(maskedPaths);
        }

        if (!newCommitHash) throw new Error('无法确定用于自动存档的提交哈希');

        try { await git.tag(['-d', targetTag]); } catch (delLocalErr) {}
        try { await git.push(['origin', `:refs/tags/${targetTag}`]); } catch (delRemoteErr) {}

        const nowTimestampOverwrite = new Date().toISOString();
        const fullTagMessageOverwrite = `${originalDescription}\nLast Updated: ${nowTimestampOverwrite}`;
        await git.addAnnotatedTag(targetTag, fullTagMessageOverwrite, newCommitHash);

        try {
             await git.push('origin', targetTag);
        } catch (pushTagError) {
             await git.tag(['-d', targetTag]);
             throw pushTagError;
        }
        console.log(`[Cloud Saves Auto] 成功自动覆盖存档: ${targetTag}`);

    } catch (error) {
        console.error(`[Cloud Saves Auto] 自动覆盖存档失败 (${config?.autoSaveTargetTag}):`, error);
    } finally {
        currentOperation = null;
    }
}

function setupBackendAutoSaveTimer() {
    if (autoSaveBackendTimer) {
        clearInterval(autoSaveBackendTimer);
        autoSaveBackendTimer = null;
    }

    readConfig().then(config => {
        if (config.is_authorized && config.autoSaveEnabled && config.autoSaveTargetTag) {
            let intervalMilliseconds = (config.autoSaveInterval > 0 ? config.autoSaveInterval : 30) * 60 * 1000;
            if (intervalMilliseconds < 60000) intervalMilliseconds = 60000;
            autoSaveBackendTimer = setInterval(performAutoSave, intervalMilliseconds);
        }
    }).catch(err => {
        console.error('[Cloud Saves] 启动后端定时器前读取配置失败:', err);
    });
}

async function init(router) {
    console.log('[cloud-saves] 初始化云存档插件 (simple-git)...');
    console.log('[cloud-saves] 插件 UI 访问地址 (如果端口不是8000请自行修改): http://127.0.0.1:8000/api/plugins/cloud-saves/ui');

    try {
        router.use('/static', express.static(path.join(__dirname, 'public')));
        router.use(express.json());
        router.get('/ui', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        router.get('/info', (req, res) => {
            res.json(info);
        });

        router.get('/config', async (req, res) => {
            try {
                const config = await readConfig();
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    display_name: config.display_name || '',
                    branch: config.branch || DEFAULT_BRANCH,
                    is_authorized: config.is_authorized || false,
                    username: config.username || null,
                    autoSaveEnabled: config.autoSaveEnabled || false,
                    autoSaveInterval: config.autoSaveInterval || 30,
                    autoSaveTargetTag: config.autoSaveTargetTag || '',
                    has_github_token: !!config.github_token,
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: '读取配置失败', error: error.message });
            }
        });

        router.post('/config', async (req, res) => {
            try {
                const {
                    repo_url, github_token, display_name, branch, is_authorized,
                    autoSaveEnabled, autoSaveInterval, autoSaveTargetTag
                } = req.body;
                let currentConfig = await readConfig();

                currentConfig.repo_url = repo_url !== undefined ? repo_url.trim() : currentConfig.repo_url;
                if (github_token) currentConfig.github_token = github_token;
                currentConfig.display_name = display_name !== undefined ? display_name.trim() : currentConfig.display_name;
                currentConfig.branch = branch !== undefined ? (branch.trim() || DEFAULT_BRANCH) : currentConfig.branch;
                if (is_authorized !== undefined) currentConfig.is_authorized = !!is_authorized;
                if (autoSaveEnabled !== undefined) currentConfig.autoSaveEnabled = !!autoSaveEnabled;
                
                if (autoSaveInterval !== undefined) {
                    const interval = parseFloat(autoSaveInterval);
                    if (isNaN(interval) || interval <= 0) return res.status(400).json({ success: false, message: '无效的自动存档间隔。' });
                    currentConfig.autoSaveInterval = interval;
                }
                
                if (autoSaveTargetTag !== undefined) currentConfig.autoSaveTargetTag = autoSaveTargetTag.trim();

                await saveConfig(currentConfig);
                setupBackendAutoSaveTimer();

                const safeConfig = {
                    repo_url: currentConfig.repo_url,
                    display_name: currentConfig.display_name,
                    branch: currentConfig.branch,
                    is_authorized: currentConfig.is_authorized,
                    username: currentConfig.username,
                    autoSaveEnabled: currentConfig.autoSaveEnabled,
                    autoSaveInterval: currentConfig.autoSaveInterval,
                    autoSaveTargetTag: currentConfig.autoSaveTargetTag
                };
                res.json({ success: true, message: '配置保存成功', config: safeConfig });
            } catch (error) {
                res.status(500).json({ success: false, message: '保存配置失败', error: error.message });
            }
        });

        router.post('/authorize', async (req, res) => {
             let authGit; 
            try {
                const { branch } = req.body;
                let config = await readConfig();
                const targetBranch = branch || config.branch || DEFAULT_BRANCH;

                if (!config.repo_url || !config.github_token) {
                    return res.status(400).json({ success: false, message: '仓库URL和GitHub Token未配置' });
                }

                if (branch && config.branch !== targetBranch) config.branch = targetBranch;
                config.is_authorized = false;

                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ success: false, message: initResult.message, details: initResult.details });
                }
                
                authGit = simpleGit(DATA_DIR);

                try {
                     await authGit.add('.');
                     const status = await authGit.status();
                     if (!status.isClean()) {
                         try {
                             await authGit.addConfig('user.name', 'Cloud Saves Plugin', false, 'local');
                             await authGit.addConfig('user.email', 'cloud-saves@plugin.local', false, 'local');
                         } catch (configError) {}
                         await authGit.commit('Initial commit of existing data directory');
                     }
                 } catch (initialCommitError) {}

                let authUrl = config.repo_url;
                if (config.repo_url.startsWith('https://') && !config.repo_url.includes('@')) {
                    authUrl = config.repo_url.replace('https://', `https://x-access-token:${config.github_token}@`);
                }
                const remotes = await authGit.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin) {
                     if (origin.refs.push !== authUrl) await authGit.remote(['set-url', 'origin', authUrl]);
                } else await authGit.addRemote('origin', authUrl);

                try {
                    await authGit.fetch(['origin', '--tags', '--prune', '--force']);
                } catch(fetchError) {
                     await saveConfig(config);
                     return res.status(400).json({
                         success: false,
                         message: '配置错误或权限不足：无法访问远程仓库或获取标签。',
                         details: fetchError.message
                     });
                }
                
                let remoteBranchExists = false;
                 try {
                     const remoteHeads = await authGit.listRemote(['--heads', 'origin', targetBranch]);
                     remoteBranchExists = typeof remoteHeads === 'string' && remoteHeads.includes(`refs/heads/${targetBranch}`);
                 } catch (lsRemoteError) {}

                if (!remoteBranchExists) {
                    try {
                        const localBranches = await authGit.branchLocal();
                         if (!localBranches.all.includes(targetBranch)) await authGit.checkout(['-b', targetBranch]); 
                         else await authGit.checkout(targetBranch);
                         
                        await authGit.push(['--set-upstream', 'origin', targetBranch]);
                    } catch (createBranchError) {
                         await saveConfig(config);
                         return res.status(500).json({ success: false, message: `無法建立同步分支 ${targetBranch}`, details: createBranchError.message });
                    }
                }

                config.is_authorized = true;
                config.branch = targetBranch;

                try {
                    const validationResponse = await fetch('https://api.github.com/user', {
                        headers: { 'Authorization': `token ${config.github_token}` }
                    });
                    if (validationResponse.ok) {
                        const userData = await validationResponse.json();
                        config.username = userData.login || null;
                    }
                } catch (fetchUserError) {}

                await saveConfig(config);
                setupBackendAutoSaveTimer();

                const safeConfig = {
                    repo_url: config.repo_url,
                    display_name: config.display_name,
                    branch: config.branch,
                    is_authorized: config.is_authorized,
                    username: config.username,
                    autoSaveEnabled: config.autoSaveEnabled,
                    autoSaveInterval: config.autoSaveInterval,
                    autoSaveTargetTag: config.autoSaveTargetTag
                };

                res.json({ success: true, message: '授权和配置成功', config: safeConfig });

            } catch (error) {
                 try {
                      let cfg = await readConfig();
                      cfg.is_authorized = false;
                      await saveConfig(cfg);
                 } catch (saveErr) {}
                res.status(500).json({ success: false, message: '授权过程中发生错误', error: error.message });
            }
        });

        router.get('/status', async (req, res) => {
            try {
                const status = await getGitStatus();
                const tempStashStatus = await checkTempStash();
                res.json({ success: true, status: { ...status, tempStash: tempStashStatus } });
            } catch (error) {
                res.status(500).json({ success: false, message: error.message || '获取状态失败', details: error.details });
            }
        });

        router.get('/saves', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const result = await listSaves();
                res.json(result);
            } catch (error) {
                res.status(500).json(error);
            }
        });

        router.post('/saves', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const { name, description } = req.body;
                if (!name) return res.status(400).json({ success: false, message: '需要提供存档名称' });
                const result = await createSave(name, description);
                res.json(result);
            } catch (error) {
                 res.status(500).json({ success: false, message: '创建存档时发生意外错误', details: error.message });
            }
        });

        router.post('/saves/load', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const { tagName } = req.body;
                if (!tagName) return res.status(400).json({ success: false, message: '需要提供存档标签名' });
                const result = await loadSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '加载存档时发生意外错误', details: error.message });
            }
        });

        router.delete('/saves/:tagName', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const { tagName } = req.params;
                if (!tagName) return res.status(400).json({ success: false, message: '需要提供存档标签名' });
                const result = await deleteSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '删除存档时发生意外错误', details: error.message });
            }
        });

        router.put('/saves/:oldTagName', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const { oldTagName } = req.params;
                const { newName, description } = req.body;
                if (!oldTagName || !newName) return res.status(400).json({ success: false, message: '需要提供旧存档标签名和新名称' });
                const result = await renameSave(oldTagName, newName, description);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '重命名存档时发生意外错误', details: error.message });
            }
        });

        router.get('/saves/diff', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const { tag1, tag2 } = req.query;
                if (!tag1 || !tag2) return res.status(400).json({ success: false, message: '需要提供两个存档标签名/引用' });
                const result = await getSaveDiff(tag1, tag2);
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '获取存档差异时发生意外错误', details: error.message });
            }
        });

        router.post('/stash/apply', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const result = await applyTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '应用临时Stash时发生意外错误', details: error.message });
            }
        });

        router.post('/stash/discard', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            try {
                const result = await discardTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ success: false, message: '丢弃临时Stash时发生意外错误', details: error.message });
            }
        });

                router.post('/saves/:tagName/overwrite', async (req, res) => {
            if (currentOperation) return res.status(409).json({ success: false, message: `正在进行操作: ${currentOperation}` });
            currentOperation = 'overwrite_save';
            const { tagName } = req.params;
            let git;
            try {
                const config = await readConfig();
                if (!config.is_authorized) return res.status(401).json({ success: false, message: '未授权，请先连接仓库' });
                
                git = await getGitInstance();
                const branchToUse = config.branch || DEFAULT_BRANCH;

                let originalDescription = `Overwrite of ${tagName}`;
                try {
                     const tagInfoRaw = await git.raw('tag', '-n1', '-l', tagName, '--format=%(contents)');
                     if (tagInfoRaw) originalDescription = tagInfoRaw.trim().split('\n')[0];
                } catch (tagInfoError) {}

                await ensureGitignoreHidden();
                const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
                let maskedPaths = [];
                let newCommitHash;

                try {
                    maskedPaths = await maskNestedGit(extensionsPath);
                    await removeGitlinksFromIndex(git, 'default-user/extensions/');

                    await git.add('.');
                    const status = await git.status();
                    const hasChanges = !status.isClean();

                    if (hasChanges) {
                        try {
                            const commitResult = await git.commit(`Overwrite save: ${tagName}`);
                            newCommitHash = commitResult.commit;
                            try { await git.push('origin', branchToUse); } catch (pushCommitError) {}
                        } catch (commitError) {
                             if (commitError.message.includes('nothing to commit')) {
                                 newCommitHash = await git.revparse('HEAD');
                             } else throw commitError;
                        }
                    } else {
                        newCommitHash = await git.revparse('HEAD');
                    }
                } finally {
                    await unmaskNestedGit(maskedPaths);
                }

                 if (!newCommitHash) throw new Error('无法确定用于覆盖的提交哈希');

                try { await git.tag(['-d', tagName]); } catch(e) {}
                try { await git.push(['origin', `:refs/tags/${tagName}`]); } catch (delRemoteErr) {}

                const nowTimestampOverwrite = new Date().toISOString();
                const fullTagMessageOverwrite = `${originalDescription}\nLast Updated: ${nowTimestampOverwrite}`;
                await git.addAnnotatedTag(tagName, fullTagMessageOverwrite, newCommitHash);

                try {
                    await git.push('origin', tagName);
                } catch (pushTagError) {
                     await git.tag(['-d', tagName]);
                     throw pushTagError;
                }
                
                res.json({ success: true, message: '存档覆盖成功', tag: tagName });

            } catch (error) {
                res.status(500).json({ success: false, message: '覆盖存档时发生意外错误', details: error.message });
            } finally {
                currentOperation = null;
            }
        });

        // 啟動後台自動存檔計時器
        setupBackendAutoSaveTimer();

    } catch (error) {
        console.error('[cloud-saves] 初始化插件期间发生错误:', error);
    }
} // 結束 init 函數

// 匯出插件 (這段剛才被截斷了，是擴展能正常運作的關鍵)
module.exports = {
    info,
    init
};
