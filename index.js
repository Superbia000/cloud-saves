/**
 * ============================================================================
 * SillyTavern Cloud Saves 插件 - 云端存档备份/恢复系统
 * ============================================================================
 * 
 * 功能概述：
 *   本插件通过 GitHub 仓库实现 SillyTavern 数据的云端备份和恢复。
 *   核心机制是将 data/ 目录下的内容通过 Git 进行版本控制，
 *   并使用 Git 标签(tag)来标记不同的存档点，从而支持：
 *     - 创建存档（快照）
 *     - 加载/恢复存档
 *     - 删除存档
 *     - 重命名存档
 *     - 查看存档差异
 *     - 定时自动存档（覆盖模式或创建新模式）
 * 
 * 关键技术难点与解决方案：
 *   SillyTavern 的 data/default-user/extensions/ 目录下，
 *   各个子插件目录内部包含 .git 文件夹（即嵌套 Git 仓库）。
 *   这会导致 Git 将它们视为 submodule（Gitlink），
 *   从而无法将插件内部文件作为普通文件进行版本追踪。
 * 
 *   解决方案（"终极破解"）：
 *     在存档前，将所有嵌套的 .git 目录临时重命名为 _git_cloud_backup
 *     （不以点开头，规避 .gitignore 的忽略规则），
 *     存档完成后恢复为 .git。这样 Git 会把它们当作普通目录进行文件追踪。
 * 
 * 依赖项：
 *   - simple-git: Node.js 的 Git 操作封装库
 *   - node-fetch: 用于 GitHub API 调用（验证 token）
 *   - express: Web 路由框架（由 SillyTavern 主程序注入）
 *   - fs (promises): Node.js 文件系统操作
 *   - path: 路径处理
 *   - crypto: 加密模块（实际使用较少）
 * 
 * ============================================================================
 */

// =========================== 依赖导入 ===========================

// fs.promises: 使用 Promise 风格的文件系统操作，避免回调地狱
const fs = require('fs').promises;

// path: 路径拼接、解析等操作
const path = require('path');

// express: SillyTavern 注入的路由模块，用于注册 API 端点
const express = require('express');

// crypto: 加密模块（目前保留以备将来使用，如哈希校验等）
const crypto = require('crypto');

// simple-git: 提供 Promise 风格的 Git 操作接口
const simpleGit = require('simple-git');

/**
 * 终极破解常量：用于临时重命名嵌套的 .git 目录
 * 
 * 为什么不用点开头？
 *   因为 .gitignore 通常会忽略所有点开头的文件/目录，
 *   而我们需要这些改名后的目录能被 Git 追踪。
 *   使用 _git_cloud_backup 这个没有点的名字，
 *   就可以让内部的 Git 数据（objects, refs 等）作为普通文件被提交。
 */
const GIT_BACKUP_NAME = '_git_cloud_backup';

// =========================== fetch 兼容层 ===========================

/**
 * fetch 变量：用于发送 HTTP 请求（调用 GitHub API 验证 token）
 * 
 * 兼容性处理逻辑：
 *   1. 优先尝试使用 ESM 风格的 import('node-fetch')，适配新版本 Node.js
 *   2. 如果失败，回退到 CommonJS 的 require('node-fetch')
 *   3. 如果全部失败，使用 Node.js 原生 http/https 模块实现一个简易 fetch
 *      （虽然功能简陋，但足以调用 GitHub API 的 /user 端点）
 */
let fetch;
try {
    // 尝试动态导入 node-fetch（适用于支持 ESM 的环境）
    import('node-fetch').then(module => {
        fetch = module.default;
    }).catch(() => {
        // 如果动态导入失败，回退到 CommonJS require
        fetch = require('node-fetch');
    });
} catch (error) {
    // 记录导入失败的错误日志
    console.error('无法导入node-fetch:', error);

    /**
     * 简易 fetch 实现（仅支持基本 GET 请求）
     * 使用 Node.js 原生 http/https 模块手动构造请求
     * 
     * @param {string} url - 请求的 URL
     * @param {object} options - 请求选项（主要是 headers）
     * @returns {Promise<object>} - 模拟 fetch 响应对象
     */
    fetch = async (url, options) => {
        const https = require('https');
        const http = require('http');
        return new Promise((resolve, reject) => {
            // 根据 URL 协议选择 http 或 https
            const client = url.startsWith('https') ? https : http;
            const req = client.request(url, options, (res) => {
                let data = '';
                // 接收响应数据块
                res.on('data', (chunk) => { data += chunk; });
                // 响应结束时组装完整的响应对象
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        json: async () => JSON.parse(data)
                    });
                });
            });
            req.on('error', reject);
            // 如果有请求体(body)，写入请求流
            if (options && options.body) req.write(options.body);
            req.end();
        });
    };
}

// =========================== 插件元信息 ===========================

/**
 * info 对象：SillyTavern 插件注册所需的基本信息
 * SillyTavern 会读取这个对象来识别和加载插件
 */
const info = {
    id: 'cloud-saves',                                          // 插件唯一标识符
    name: 'Cloud Saves',                                        // 插件显示名称
    description: '通过GitHub仓库创建、管理和恢复SillyTavern的云端存档。',  // 插件描述
    version: '1.0.0',                                           // 插件版本号
};

// =========================== 路径与默认配置 ===========================

// 配置文件路径（与插件脚本在同一目录下）
const CONFIG_PATH = path.join(__dirname, 'config.json');

// SillyTavern 的数据目录路径（通过 process.cwd() 获取运行目录）
const DATA_DIR = path.join(process.cwd(), 'data');

// 默认分支名
const DEFAULT_BRANCH = 'main';

/**
 * DEFAULT_CONFIG: 默认配置对象
 * 包含了所有配置项的默认值，当配置文件不存在或格式错误时使用
 * 
 * 各字段说明：
 *   repo_url:        GitHub 仓库的 HTTPS URL
 *   branch:          操作的分支名
 *   username:        通过 GitHub API 获取到的用户名（自动填充）
 *   github_token:    GitHub 个人访问令牌（Personal Access Token）
 *   display_name:    用户自定义的显示名称
 *   is_authorized:   是否已通过授权验证
 *   last_save:       最近一次创建的存档信息
 *   current_save:    当前加载的存档信息
 *   has_temp_stash:  是否存在临时 stash（加载存档前的自动备份）
 *   autoSaveEnabled: 是否启用定时自动存档
 *   autoSaveInterval: 定时存档间隔（分钟）
 *   autoSaveTargetTag: 覆盖模式下要覆盖的目标存档标签名
 *   autoSaveMode:    自动存档模式：'overwrite'（覆盖）或 'create'（创建新档）
 *   autoSaveTimezoneOffset: 浏览器时区偏移量（分钟），用于创建模式的命名
 */
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
    autoSaveMode: 'overwrite',
    autoSaveTimezoneOffset: 0,
};

// =========================== 全局状态变量 ===========================

/**
 * currentOperation: 当前正在执行的操作名称
 * 用于防止并发操作冲突。当有操作执行时，新的请求会被拒绝（返回 409）
 * 可能的值：'create_save' | 'list_saves' | 'load_save' | 'delete_save' 
 *          | 'rename_save' | 'get_save_diff' | 'auto_save' | 'overwrite_save' | null
 */
let currentOperation = null;

/**
 * autoSaveBackendTimer: 后端定时存档的计时器引用
 * 使用 setInterval 实现，保存引用以便在配置更改时清除和重建
 */
let autoSaveBackendTimer = null;

// =========================== 配置读写函数 ===========================

/**
 * readConfig - 读取并解析配置文件
 * 
 * 流程：
 *   1. 读取 config.json 文件内容
 *   2. 解析 JSON
 *   3. 为缺失的字段填充默认值（兼容配置文件的版本升级）
 *   4. 如果文件不存在或解析失败，创建默认配置文件并返回默认值
 * 
 * @returns {Promise<object>} - 当前的配置对象（已合并默认值）
 */
async function readConfig() {
    try {
        const data = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = JSON.parse(data);
        // 确保所有字段都有合理的默认值，防止旧配置文件升级后字段缺失
        config.branch = config.branch || DEFAULT_BRANCH;
        config.autoSaveEnabled = config.autoSaveEnabled === undefined ? DEFAULT_CONFIG.autoSaveEnabled : config.autoSaveEnabled;
        config.autoSaveInterval = config.autoSaveInterval === undefined ? DEFAULT_CONFIG.autoSaveInterval : config.autoSaveInterval;
        config.autoSaveTargetTag = config.autoSaveTargetTag === undefined ? DEFAULT_CONFIG.autoSaveTargetTag : config.autoSaveTargetTag;
        config.autoSaveMode = config.autoSaveMode === undefined ? DEFAULT_CONFIG.autoSaveMode : config.autoSaveMode;
        config.autoSaveTimezoneOffset = config.autoSaveTimezoneOffset === undefined ? DEFAULT_CONFIG.autoSaveTimezoneOffset : config.autoSaveTimezoneOffset;
        return config;
    } catch (error) {
        // 配置文件不存在或格式错误，创建默认配置
        console.warn('Failed to read or parse config, creating default:', error.message);
        await fs.writeFile(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return { ...DEFAULT_CONFIG };
    }
}

/**
 * saveConfig - 将配置对象写入配置文件
 * 
 * @param {object} config - 要保存的配置对象
 * @returns {Promise<void>}
 */
async function saveConfig(config) {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// =========================== .gitignore 维护 ===========================

/**
 * ensureGitignoreHidden - 确保 .gitignore 文件中包含必要的忽略规则
 * 
 * 目的：
 *   防止 _git_cloud_hidden 目录（旧版屏蔽方案）被意外提交到 GitHub。
 *   虽然新版使用 _git_cloud_backup，但需要兼容旧版本遗留的文件。
 * 
 * 注意：
 *   _git_cloud_hidden 是旧版本的改名方案，新版本使用 _git_cloud_backup。
 *   这个函数确保旧版本的遗留数据不会被提交。
 */
async function ensureGitignoreHidden() {
    const gitignorePath = path.join(DATA_DIR, '.gitignore');
    try {
        let content = '';
        try { content = await fs.readFile(gitignorePath, 'utf8'); } catch(e){}
        // 检查是否已包含忽略规则
        if (!content.includes('.git_cloud_hidden')) {
            // 确保内容末尾有换行符
            if (content && !content.endsWith('\n')) content += '\n';
            // 追加忽略规则
            content += '.git_cloud_hidden\n';
            await fs.writeFile(gitignorePath, content, 'utf8');
            console.log(`[cloud-saves] 自动在 .gitignore 加入了 .git_cloud_hidden`);
        }
    } catch(e) {
        console.error(`[cloud-saves] 更新 .gitignore 失败:`, e);
    }
}

// =========================== 嵌套 Git 目录处理（核心破解） ===========================

/**
 * maskNestedGit - 隐藏（绑架）所有嵌套的 .git 目录
 * 
 * 这是本插件的核心机制之一，用于解决嵌套 Git 仓库的追踪问题。
 * 
 * 工作原理：
 *   1. 递归扫描目标目录下的所有子目录
 *   2. 找到所有名为 .git 的子目录（即子插件的 Git 仓库）
 *   3. 将它们重命名为 _git_cloud_backup（不带点前缀的名字）
 *   4. 在重命名后的目录内：
 *      a. 强制写入 !* 的 .gitignore，覆盖父级忽略规则，确保所有文件都被追踪
 *      b. 创建 .gitkeep 文件在关键空目录中，确保 Git 保留目录结构
 *   5. 跳过 node_modules 目录以提升扫描速度
 *   6. 同时处理旧的 .git_cloud_hidden 目录（升级旧版本的数据）
 * 
 * @param {string} targetDir - 要扫描的起始目录
 * @returns {Promise<Array<string>>} - 被重命名的原始 .git 路径列表（用于 unmaskNestedGit 恢复）
 */
async function maskNestedGit(targetDir) {
    const maskedPaths = [];  // 记录所有被处理的路径

    /**
     * scan - 递归扫描函数
     * @param {string} currentDir - 当前正在扫描的目录
     */
    async function scan(currentDir) {
        try {
            const entries = await fs.readdir(currentDir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentDir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === '.git') {
                        // === 发现嵌套的 .git 目录，开始处理 ===
                        const hiddenPath = path.join(currentDir, GIT_BACKUP_NAME);
                        try {
                            // 1. 删除可能存在的旧重命名目录（防止冲突）
                            await fs.rm(hiddenPath, { recursive: true, force: true }).catch(() => {});
                            // 2. 将 .git 重命名为 _git_cloud_backup
                            await fs.rename(fullPath, hiddenPath);
                            
                            // 3. 暴力破解：强制植入白名单规则
                            //    !* 表示覆盖所有父级忽略规则，无条件追踪此目录下的所有内容
                            await fs.writeFile(path.join(hiddenPath, '.gitignore'), "!*\n").catch(() => {});
                            
                            // 4. 补血机制：在 Git 内部的关键空目录中植入 .gitkeep
                            //    Git 不会追踪空目录，但这几个目录对 Git 的正常运行至关重要
                            //    通过 .gitkeep 确保它们被保留
                            const keepDirs = [
                                'objects/info',   // Git 对象信息
                                'objects/pack',   // Git 打包对象
                                'refs/heads',     // 分支引用
                                'refs/tags',      // 标签引用
                                'branches',       // 分支信息
                                'info'            // 仓库信息
                            ];
                            for (const dir of keepDirs) {
                                const keepPath = path.join(hiddenPath, dir);
                                await fs.mkdir(keepPath, { recursive: true }).catch(() => {});
                                await fs.writeFile(path.join(keepPath, '.gitkeep'), "").catch(() => {});
                            }
                            
                            // 记录被处理的路径，以便之后恢复
                            maskedPaths.push(fullPath);
                        } catch (e) {
                            console.error(`[cloud-saves] 无法隐藏 ${fullPath}:`, e);
                        }
                    } else if (entry.name === '.git_cloud_hidden') {
                        // === 处理旧版本的隐藏目录：升级到新格式 ===
                        const hiddenPath = path.join(currentDir, GIT_BACKUP_NAME);
                        try {
                            await fs.rename(fullPath, hiddenPath);
                            maskedPaths.push(path.join(currentDir, '.git'));
                        } catch (e) {}
                    } else if (entry.name !== GIT_BACKUP_NAME && entry.name !== 'node_modules') {
                        // === 跳过无用目录，递归扫描下一层 ===
                        // 跳过大备份目录本身（避免无限递归）和 node_modules（加速扫描）
                        await scan(fullPath);
                    }
                }
            }
        } catch (e) {}
    }
    await scan(targetDir);
    return maskedPaths;
}

/**
 * unmaskNestedGit - 恢复（解绑）所有被隐藏的嵌套 .git 目录
 * 
 * 这是 maskNestedGit 的逆操作。
 * 将 _git_cloud_backup 重命名回 .git，同时清理我们注入的强制追踪文件。
 * 
 * @param {Array<string>} maskedPaths - maskNestedGit 返回的原始路径列表
 */
async function unmaskNestedGit(maskedPaths) {
    for (const originalGit of maskedPaths) {
        // 根据原始路径推导出重命名后的路径
        const hiddenPath = originalGit.replace(/\.git$/, GIT_BACKUP_NAME);
        try {
            // 1. 清理我们注入的强制追踪规则文件
            await fs.rm(path.join(hiddenPath, '.gitignore'), { force: true }).catch(() => {});
            // 2. 删除可能残留的原始 .git（防止重命名冲突）
            await fs.rm(originalGit, { recursive: true, force: true }).catch(() => {});
            // 3. 恢复为 .git
            await fs.rename(hiddenPath, originalGit);
        } catch (e) {}
    }
}

// =========================== Gitlink 清理 ===========================

/**
 * removeGitlinksFromIndex - 从 Git 索引中清除旧有的 Gitlink（子模块引用）
 * 
 * 问题背景：
 *   如果之前嵌套的 .git 目录被 Git 当作子模块（Gitlink, mode=160000）记录在索引中，
 *   那么即使现在它们被重命名为 _git_cloud_backup，Git 仍然会保留旧的 Gitlink 引用，
 *   导致无法以普通文件形式追踪这些目录。
 * 
 * 解决方案：
 *   扫描索引中所有 mode=160000 的文件记录，如果它们在目标前缀路径下，
 *   使用 git rm --cached 将它们从索引中移除（但保留工作区文件）。
 *   这样下一次 git add 就会将它们作为普通文件/目录重新索引。
 * 
 * @param {object} git - simple-git 实例
 * @param {string} prefix - 要检查的路径前缀（如 'default-user/extensions/'）
 */
async function removeGitlinksFromIndex(git, prefix) {
    console.log(`[cloud-saves] 正在检查是否有旧 Gitlink 参照: ${prefix}`);
    const prefixPath = prefix.endsWith('/') ? prefix : prefix + '/';

    try {
        // 使用 git ls-files --stage 获取索引中所有文件的详细信息
        // 输出格式：<mode> <object> <stage>\t<file>
        const lsFilesOutput = await git.raw('ls-files', '--stage');
        if (!lsFilesOutput) return;

        const lines = lsFilesOutput.trim().split('\n');
        const gitlinksToRemove = [];

        // 逐行解析，找出 mode=160000（Gitlink）且在目标前缀下的文件
        for (const line of lines) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                const mode = parts[0];          // 文件模式
                const filePath = parts.slice(3).join(' '); // 文件路径
                // 160000 是 Gitlink（子模块）的特殊模式
                if (mode === '160000' && filePath.startsWith(prefixPath)) {
                    gitlinksToRemove.push(filePath);
                }
            }
        }

        // 批量移除 Gitlink 引用（使用 --cached 保留工作区文件）
        if (gitlinksToRemove.length > 0) {
            console.log(`[cloud-saves] 正在移除 ${gitlinksToRemove.length} 个扩展 Gitlink，改为完整追踪实体档案...`);
            for (const filePath of gitlinksToRemove) {
                try {
                    // --cached: 只从索引中移除，保留工作区文件
                    // --ignore-unmatch: 如果文件不在索引中也继续执行（容错处理）
                    await git.raw('rm', '--cached', '--ignore-unmatch', filePath);
                } catch (rmError) {}
            }
        }
    } catch (error) {
        console.error(`[cloud-saves] 修正 Gitlink 时发生错误:`, error);
    }
}

// =========================== Git 实例创建 ===========================

/**
 * getGitInstance - 创建并配置 Git 操作实例
 * 
 * 每次调用都会返回一个新的 simple-git 实例，配置好：
 *   1. 工作目录（通常是 DATA_DIR）
 *   2. 认证信息（通过 GitHub Token 嵌入远程 URL）
 *   3. 并发处理限制
 * 
 * 认证 URL 格式：
 *   https://x-access-token:{token}@github.com/user/repo.git
 * 
 * @param {string} cwd - Git 工作目录，默认为 DATA_DIR
 * @returns {Promise<object>} - 配置好的 simple-git 实例
 */
async function getGitInstance(cwd = DATA_DIR) {
    const options = {
        baseDir: cwd,                    // Git 操作的基准目录
        binary: 'git',                   // Git 可执行文件名
        maxConcurrentProcesses: 6,       // 最大并发 Git 进程数
    };
    const git = simpleGit(options);
    const config = await readConfig();

    // 如果是在 DATA_DIR 操作且已配置仓库和 token，自动设置认证的远程 URL
    if (cwd === DATA_DIR && config.repo_url && config.github_token) {
        try {
            const remotes = await git.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            const originalUrl = config.repo_url;
            let authUrl = originalUrl;

            // 构造带认证信息的 URL：在 https:// 后面插入 x-access-token
            if (originalUrl.startsWith('https://') && !originalUrl.includes('@')) {
                authUrl = originalUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
            }
            // 如果远程 URL 不一致则更新
            if (origin && origin.refs.push !== authUrl) {
                await git.remote(['set-url', 'origin', authUrl]);
            } else if (!origin && originalUrl) {
                await git.addRemote('origin', authUrl);
            }
        } catch (error) {
            console.warn(`[cloud-saves] 无法配置授权远端 URL:`, error.message);
        }
    }
    
    return git;
}

/**
 * handleGitError - 统一处理 Git 操作错误
 * 
 * 生成标准化的错误响应对象，包含成功标志、错误信息和详细堆栈。
 * 
 * @param {Error} error - 捕获的错误对象
 * @param {string} operation - 正在执行的操作名称（用于错误消息）
 * @returns {object} - 标准错误响应 { success: false, message, details, error }
 */
function handleGitError(error, operation = 'Git operation') {
    console.error(`[cloud-saves] ${operation} failed:`, error.message);
    return {
        success: false,
        message: `${operation} failed`,
        details: error.message || error.stack || 'Unknown simple-git error',
        error: error
    };
}

// =========================== Git 仓库初始化 ===========================

/**
 * isGitInitialized - 检查 data 目录是否已经完成 Git 初始化
 * 
 * 检查逻辑：
 *   1. 检查 .git 目录是否存在
 *   2. 使用 checkIsRepo() 进一步确认是否是有效的 Git 仓库
 * 
 * @returns {Promise<boolean>}
 */
async function isGitInitialized() {
    try {
        const git = simpleGit(DATA_DIR);
        const gitDir = path.join(DATA_DIR, '.git');
        try {
            await fs.access(gitDir);  // 检查 .git 目录是否存在
        } catch {
            return false;              // .git 目录不存在
        }
        return await git.checkIsRepo(); // 进一步验证仓库有效性
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error("[cloud-saves] 检查 git 初始化发生错误:", error);
        }
        return false;
    }
}

/**
 * addGitkeepRecursively - 递归地在所有空目录中添加 .gitkeep 文件
 * 
 * 背景：
 *   Git 不会追踪空目录。但在我们的使用场景中，
 *   空的子目录也是有意义的（如默认角色目录结构），
 *   为了让 Git 能追踪这些目录结构，需要在空目录中放置 .gitkeep 文件。
 * 
 * @param {string} directory - 要处理的起始目录
 */
async function addGitkeepRecursively(directory) {
    try {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        let hasGitkeep = false;
        const subDirectories = [];

        for (const entry of entries) {
            if (entry.isFile() && entry.name === '.gitkeep') {
                hasGitkeep = true;  // 当前目录已有 .gitkeep
            }
            if (entry.isDirectory()) {
                // 跳过 .git 目录（避免干扰仓库本身）
                if (entry.name !== '.git') {
                    subDirectories.push(path.join(directory, entry.name));
                }
            }
        }

        // 如果当前目录为空（没有文件且有子目录的已经在上面加入了递归列表），添加 .gitkeep
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

        // 递归处理子目录
        for (const subDir of subDirectories) {
            await addGitkeepRecursively(subDir);
        }
    } catch (error) {}
}

/**
 * initGitRepo - 在 data 目录中初始化 Git 仓库
 * 
 * 流程：
 *   1. 检查是否已初始化，如果是则跳过
 *   2. 执行 git init
 *   3. 递归添加 .gitkeep 文件到所有空目录
 *   4. 创建 .gitignore 文件：
 *      - !* 覆盖父级忽略规则，确保 data 目录内容被追踪
 *      - 明确忽略一些不需要备份的子目录（如缓存、临时文件）
 * 
 * @returns {Promise<object>} - 操作结果
 */
async function initGitRepo() {
    // 如果已经初始化，直接返回成功
    if (await isGitInitialized()) {
        console.log('[cloud-saves] Git repository already initialized in data directory.');
        await ensureGitignoreHidden();
        return { success: true, message: 'Git仓库已在data目录中初始化' };
    }

    console.log('[cloud-saves] 正在data目录中初始化Git仓库:', DATA_DIR);
    try {
        const git = simpleGit(DATA_DIR);
        await git.init();  // 执行 git init
        console.log('[cloud-saves] git init 成功');

        // 在所有空目录中放入 .gitkeep，确保目录结构被追踪
        console.log('[cloud-saves] Adding .gitkeep files to ensure all directory tracking...');
        await addGitkeepRecursively(DATA_DIR);

        // 创建主 .gitignore 文件
        try {
            const gitignorePath = path.join(DATA_DIR, '.gitignore');
            const gitignoreContent = 
                "# 确保 data 目录内容被追踪，覆盖父级忽略规则\n!*\n\n" +
                "# 忽略不需要备份的子目录\n" +
                "_uploads/\n" +      // 上传文件（可能很大）
                "_cache/\n" +        // 缓存目录
                "_storage/\n" +      // 存储目录
                "_webpack/\n" +      // Webpack 打包输出
                ".git_cloud_hidden\n"; // 旧版本隐藏目录
            await fs.writeFile(gitignorePath, gitignoreContent, 'utf8');
            console.log(`[cloud-saves] 已成功创建主 ${gitignorePath}`);
        } catch (gitignoreError) {
            console.error(`[cloud-saves] 创建立 .gitignore 文件失败:`, gitignoreError);
        }

        return { success: true, message: 'Git仓库初始化成功，并添加了.gitkeep文件' };
    } catch (error) {
        return handleGitError(error, '初始化Git仓库');
    }
}

// =========================== 远程仓库配置 ===========================

/**
 * configureRemote - 配置远程仓库的 URL
 * 
 * 如果远程 origin 已存在，更新其 URL；如果不存在，添加新的远程仓库。
 * 自动将 GitHub Token 嵌入 URL 以实现认证。
 * 
 * @param {string} repoUrl - GitHub 仓库的 HTTPS URL
 * @returns {Promise<object>} - 操作结果
 */
async function configureRemote(repoUrl) {
    try {
        const git = await getGitInstance();
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        
        // 构造带认证信息的 URL
        let authUrl = repoUrl;
        const config = await readConfig();
        if (repoUrl.startsWith('https://') && config.github_token && !repoUrl.includes('@')) {
            authUrl = repoUrl.replace('https://', `https://x-access-token:${config.github_token}@`);
        }

        if (origin) {
            // 远程已存在，更新 URL（仅在 URL 不同时更新）
            if (origin.refs.push !== authUrl) {
                await git.remote(['set-url', 'origin', authUrl]);
            }
        } else {
            // 远程不存在，添加新的
            await git.addRemote('origin', authUrl);
        }
        return { success: true, message: '远程仓库配置成功' };
    } catch (error) {
        return handleGitError(error, '配置远程仓库');
    }
}

// =========================== 存档创建 ===========================

/**
 * createSave - 创建一个新的云端存档
 * 
 * 这是本插件的核心功能之一。完整流程如下：
 * 
 * 1. 【预处理】确保 .gitignore 包含隐藏规则
 * 2. 【屏蔽嵌套 Git】调用 maskNestedGit 将所有子插件的 .git 目录重命名
 * 3. 【清理 Gitlink】移除索引中旧的子模块引用
 * 4. 【暂存变更】git add .
 * 5. 【提交】如果有变更则 git commit
 * 6. 【恢复嵌套 Git】调用 unmaskNestedGit 恢复 .git 目录
 * 7. 【创建标签】使用 git tag -a 创建带注释的标签
 * 8. 【推送】推送标签和分支到远程仓库
 * 9. 【更新配置】记录最后保存的存档信息
 * 
 * 标签命名格式：
 *   save_{timestamp}_{base64url(name)}
 *   其中 timestamp 是 Date.now() 的值
 *   base64url 编码确保文件名安全（不包含 / 等特殊字符）
 * 
 * @param {string} name - 存档名称
 * @param {string} description - 存档描述（可选）
 * @returns {Promise<object>} - 操作结果，包含 saveData
 */
async function createSave(name, description) {
    try {
        // 设置当前操作标志，防止并发操作
        currentOperation = 'create_save';
        console.log(`[cloud-saves] 正在创建新存盘: ${name}, 描述: ${description}`);
        
        await ensureGitignoreHidden();
        const config = await readConfig();
        const git = await getGitInstance();
        const branchToPush = config.branch || DEFAULT_BRANCH;

        // 生成标签名：使用 base64url 编码名称以确保安全
        const encodedName = Buffer.from(name).toString('base64url');
        const tagName = `save_${Date.now()}_${encodedName}`;
        const nowTimestamp = new Date().toISOString();

        // 标签消息包含描述和最后更新时间
        const tagMessage = description || `存档: ${name}`;
        const fullTagMessage = `${tagMessage}\nLast Updated: ${nowTimestamp}`;

        // 确定 extensions 目录路径
        const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
        let maskedPaths = [];
        let commitNeeded = false;

        try {
            // ======== 核心步骤：屏蔽嵌套 Git 目录 ========
            maskedPaths = await maskNestedGit(extensionsPath);
            // 清理旧的 Gitlink 引用，确保文件能被正常追踪
            await removeGitlinksFromIndex(git, 'default-user/extensions/');

            // 暂存所有变更
            await git.add('.');
            const status = await git.status();
            commitNeeded = !status.isClean();

            // 如果有变更，提交
            if (commitNeeded) {
                console.log('[cloud-saves] 已扫描完成，执行提交...');
                try {
                    await git.commit(`存档: ${name}`);
                } catch (commitError) {
                    // "nothing to commit" 错误是正常的（如果所有文件都已在之前的提交中）
                    if (commitError.message.includes('nothing to commit')) {
                        commitNeeded = false;
                    } else {
                        throw commitError;
                    }
                }
            }
        } finally {
            // ======== 无论如何都要恢复嵌套 Git 目录 ========
            await unmaskNestedGit(maskedPaths);
        }

        // 创建带注释的 Git 标签
        console.log('[cloud-saves] 创建标签并推送...');
        await git.addAnnotatedTag(tagName, fullTagMessage);

        // 获取当前分支
        const currentBranchStatus = await git.branch();
        const currentBranch = currentBranchStatus.current;

        // 如果有新的提交且在正确的分支上，推送分支
        if (commitNeeded && currentBranch === branchToPush && !currentBranchStatus.detached) {
            try {
                await git.push('origin', currentBranch);
            } catch (pushError) {
                console.warn(`[cloud-saves] 推送分支错误:`, pushError.message);
            }
        }

        // 推送标签到远程仓库
        await git.push(['origin', tagName]);

        // 更新配置中的 last_save 信息
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
        // 无论如何清除当前操作标志
        currentOperation = null;
    }
}

// =========================== 存档列表获取 ===========================

/**
 * listSaves - 获取远程仓库中所有存档的列表
 * 
 * 流程：
 *   1. 使用 ls-remote 获取远程仓库中的所有 save_ 标签（高效，无需完整 fetch）
 *   2. 对比本地标签，删除本地存在但远程不存在的"幽灵"标签
 *   3. 拉取远程标签数据（获取注释、作者、日期等信息）
 *   4. 格式化返回存档列表
 * 
 * 为什么先 ls-remote 再 fetch？
 *   ls-remote 速度快，不需要下载标签数据，
 *   可以先用它确认哪些标签真实存在，清理完本地残留后再 fetch 详细信息。
 * 
 * @returns {Promise<object>} - { success, saves: Array }
 */
async function listSaves() {
    try {
        currentOperation = 'list_saves';
        console.log('[cloud-saves] 获取存档列表');
        const git = await getGitInstance();

        // ======== 步骤1: 使用 ls-remote 获取远程真实标签清单 ========
        console.log('[cloud-saves] Fetching remote tags list via ls-remote...');
        let lsRemoteOutput = '';
        try {
            lsRemoteOutput = await git.listRemote(['--tags', 'origin']);
        } catch (remoteErr) {
            // 无法访问远程仓库（例如空仓库、网络问题等）
            console.warn('[cloud-saves] 无法访问远端仓库，可能是尚未初始化完成。', remoteErr.message);
        }
        
        // 从 ls-remote 输出中提取 save_ 开头的标签名
        const remoteTags = new Set();
        if (lsRemoteOutput) {
            const lines = lsRemoteOutput.trim().split('\n');
            for (const line of lines) {
                if (!line) continue;
                // 匹配格式: <hash>\trefs/tags/<tagName>
                // 忽略 ^{} 后缀（这是 Git 对带注释标签的特殊引用）
                const match = line.match(/refs\/tags\/(save_[^\s\^]+)/);
                if (match) {
                    remoteTags.add(match[1]);
                }
            }
        }

        // ======== 步骤2: 清理本地残留的"幽灵"标签 ========
        // 本地有但远程没有的标签，说明该存档已被从远程删除，应从本地清理
        const localTagsSummary = await git.tags(['-l', 'save_*']);
        const localTags = localTagsSummary.all || [];
        let prunedCount = 0;
        for (const localTag of localTags) {
            if (!remoteTags.has(localTag)) {
                try {
                    await git.tag(['-d', localTag]);  // 删除本地标签
                    prunedCount++;
                } catch(e) {}
            }
        }
        if (prunedCount > 0) {
            console.log(`[cloud-saves] 已清理 ${prunedCount} 个不属于当前远端仓库的本地残留存档(标签)。`);
        }

        // ======== 步骤3: 拉取远程标签详细信息 ========
        console.log('[cloud-saves] Fetching tags data from remote...');
        try {
            await git.fetch(['origin', '--tags', '--force']);
        } catch (fetchErr) {
            console.warn('[cloud-saves] 拉取标签时出现警告，如果是空仓库则为正常现象。');
        }

        // 使用 git tag 的格式化输出一次性获取所有标签的详细信息
        // %00 是 null 字符分隔符，便于解析多行字段
        const formatString = "%(refname:short)%00%(creatordate:iso)%00%(taggername)%00%(subject)%00%(contents)";
        const tagOutput = await git.raw('tag', '-l', 'save_*', '--sort=-creatordate', `--format=${formatString}`);

        if (!tagOutput) return { success: true, saves: [] };

        // 解析标签信息
        const saves = tagOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('\0');
            if (parts.length < 5) return null;

            const tagName = parts[0];
            
            // 二次保险过滤：确保返回的标签确实存在于远程
            if (!remoteTags.has(tagName)) return null;

            const createdAt = new Date(parts[1]).toISOString();
            const taggerName = parts[2] || '未知';
            const subject = parts[3];      // 标签简短描述
            const body = parts[4] || '';   // 标签完整消息体

            let name = tagName;
            let description = subject;
            let updatedAt = createdAt;

            // 从标签消息体中提取 "Last Updated" 时间戳
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
            
            // 从标签名中解码存档名称
            // 标签格式：save_{timestamp}_{base64url(name)}
            const tagNameMatch = tagName.match(/^save_\d+_(.+)$/);
            if (tagNameMatch) {
                try {
                    const encodedName = tagNameMatch[1];
                    name = Buffer.from(encodedName, 'base64url').toString('utf8');
                } catch (decodeError) {
                    // 解码失败时使用原始编码文本
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

// =========================== 存档加载后的恢复处理 ===========================

/**
 * restoreCheckoutGit - 恢复被 Git checkout 还原出来的嵌套 Git 目录
 * 
 * 背景：
 *   当执行 git checkout 切换存档时，之前通过 maskNestedGit 改名并提交到仓库的
 *   _git_cloud_backup 目录会被还原到工作区。但这个目录在正常使用中应该叫 .git。
 * 
 * 此函数递归扫描目录，找到 _git_cloud_backup 或 .git_cloud_hidden 目录，
 * 将它们重命名回 .git，并清理注入的 .gitignore 和 .gitkeep 文件。
 * 同时确保必要的 Git 内部目录结构存在。
 * 
 * @param {string} targetPath - 要扫描并恢复的目录
 */
async function restoreCheckoutGit(targetPath) {
    try {
        const entries = await fs.readdir(targetPath, { withFileTypes: true });
        for (const entry of entries) {
            const entryPath = path.join(targetPath, entry.name);
            if (entry.isDirectory()) {
                // 发现被改名的 Git 目录（新版或旧版命名）
                if (entry.name === GIT_BACKUP_NAME || entry.name === '.git_cloud_hidden') {
                    const originalGit = path.join(targetPath, '.git');
                    try {
                        // 1. 删除可能存在的旧 .git 目录
                        await fs.rm(originalGit, { recursive: true, force: true }).catch(() => {});
                        // 2. 重命名回 .git
                        await fs.rename(entryPath, originalGit);
                        
                        // 3. 清理我们注入的强制追踪文件
                        await fs.rm(path.join(originalGit, '.gitignore'), { force: true }).catch(() => {});
                        await fs.rm(path.join(originalGit, '.gitkeep'), { force: true }).catch(() => {});
                        
                        // 4. 确保 Git 内部必要目录结构存在（防止 checkout 后目录缺失）
                        const requiredGitDirs = [
                            'objects/info', 'objects/pack', 
                            'refs/heads', 'refs/tags', 
                            'branches', 'info'
                        ];
                        for (const dirName of requiredGitDirs) {
                            await fs.mkdir(path.join(originalGit, dirName), { recursive: true }).catch(() => {});
                        }
                    } catch (e) {}
                } else if (entry.name !== '.git' && entry.name !== 'node_modules') {
                    // 递归处理子目录（跳过已处理的 .git 和 node_modules）
                    await restoreCheckoutGit(entryPath);
                }
            }
        }
    } catch (error) {}
}

// =========================== 存档加载 ===========================

/**
 * loadSave - 加载指定的存档到当前工作区
 * 
 * 这是本插件的另一个核心功能。完整流程：
 * 
 * 1. 【拉取标签】fetch 远程标签确保本地是最新的
 * 2. 【验证标签】检查指定的标签是否存在
 * 3. 【屏蔽嵌套 Git】调用 maskNestedGit 保护当前扩展的 .git 目录
 * 4. 【创建临时保存】如果当前有未保存的更改，先 stash 暂存并标记
 * 5. 【获取提交】通过标签获取对应的提交哈希
 * 6. 【切换版本】执行 git checkout 切换到目标提交
 * 7. 【恢复嵌套 Git】两步恢复：
 *    a. unmaskNestedGit: 恢复被屏蔽的当前扩展 .git
 *    b. restoreCheckoutGit: 恢复被 checkout 还原出来的存档中的 .git
 * 8. 【更新配置】记录当前加载的存档信息
 * 
 * 错误恢复：
 *   如果在加载过程中出错，会尝试 pop 之前创建的 stash，
 *   避免用户的未保存更改丢失。
 * 
 * @param {string} tagName - 要加载的存档标签名（如 save_1234567890_xxx）
 * @returns {Promise<object>} - { success, message, stashCreated }
 */
async function loadSave(tagName) {
    try {
        currentOperation = 'load_save';
        console.log(`[cloud-saves] 正在载入存档: ${tagName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        // 拉取所有远程标签（确保本地数据最新）
        await git.fetch(['origin', '--tags']);
        // 验证标签是否存在
        const tags = await git.tags(['-l', tagName]);
        if (!tags || !tags.all.includes(tagName)) {
            return { success: false, message: '找不到指定的存档标签' };
        }

        const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
        let maskedPaths = [];
        let stashCreated = false;

        try {
            // ======== 步骤1: 保护当前扩展的 .git 目录 ========
            maskedPaths = await maskNestedGit(extensionsPath);

            // ======== 步骤2: 如果有未保存更改，创建临时 stash ========
            const status = await git.status();
            if (!status.isClean()) {
                console.log('[cloud-saves] 检测到未保存的更改，在回档前创建临时保存点');
                const stashResult = await git.stash(['push', '-u', '-m', 'Temporary stash before loading save']);
                stashCreated = stashResult && !stashResult.includes('No local changes to save');
                config.has_temp_stash = stashCreated;
            } else {
                config.has_temp_stash = false;
            }
            
            // ======== 步骤3: 获取标签对应的提交哈希 ========
            const commit = await git.revparse([tagName]);
            if (!commit) {
                // 如果获取失败但已创建 stash，先恢复 stash
                if (stashCreated) await git.stash(['pop']);
                return { success: false, message: '获取存档提交哈希失败' };
            }

            // ======== 步骤4: 切换工作区到指定提交 ========
            // 这一步会还原存档时提交的 _git_cloud_backup 目录到工作区
            await git.checkout(commit);

        } finally {
            // ======== 步骤5: 双重恢复嵌套 Git 目录 ========
            // a. 恢复当前扩展的 .git（被 maskNestedGit 屏蔽的）
            await unmaskNestedGit(maskedPaths);
            // b. 恢复存档中还原出来的 .git（被 checkout 放出来的 _git_cloud_backup）
            await restoreCheckoutGit(extensionsPath); 
        }

        // ======== 步骤6: 记录当前加载的存档 ========
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
        console.error(`[cloud-saves] 载入存档时发生错误:`, error.message);
        // ======== 错误恢复：尝试还原 stash ========
        try {
            const cfg = await readConfig();
            if (cfg.has_temp_stash) {
                const git = await getGitInstance();
                await git.stash(['pop']);
                cfg.has_temp_stash = false;
                await saveConfig(cfg);
            }
        } catch (recoverError) {
            console.error('[cloud-saves] 错误恢复失败:', recoverError.message);
        }
        
        return { success: false, message: '加载存档失败', details: error.message };
        
    } finally {
        currentOperation = null;
    }
}

// =========================== 存档删除 ===========================

/**
 * deleteSave - 删除指定的存档（本地和远程标签）
 * 
 * 流程：
 *   1. 删除本地标签
 *   2. 推送删除到远程（push :refs/tags/{tagName}）
 *   3. 如果当前加载的存档就是被删除的，清除 current_save
 * 
 * 容错处理：
 *   如果远程删除失败（如网络问题），仍然返回成功但附带警告信息
 * 
 * @param {string} tagName - 要删除的存档标签名
 * @returns {Promise<object>}
 */
async function deleteSave(tagName) {
    try {
        currentOperation = 'delete_save';
        console.log(`[cloud-saves] 正在删除存档: ${tagName}`);
        const git = await getGitInstance();

        // 删除本地标签
        await git.tag(['-d', tagName]);
        
        // 删除远程标签
        try {
            // 格式：git push origin :refs/tags/{tagName}
            await git.push(['origin', `:refs/tags/${tagName}`]);
        } catch (pushError) {
            // 远程标签不存在或删除失败的非严重错误
            if (!pushError.message.includes('remote ref does not exist') && 
                !pushError.message.includes('deletion of')) {
                // 仍然清理本地配置中的引用
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

        // 如果当前加载的就是被删除的存档，清除引用
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

// =========================== 存档重命名 ===========================

/**
 * renameSave - 重命名存档（实质是创建新标签并删除旧标签）
 * 
 * 两种情况：
 *   1. 名称相同：只更新标签的注释信息和时间戳（原地更新）
 *   2. 名称不同：创建新标签 → 推送新标签 → 删除旧标签
 * 
 * 标签名包含 base64url 编码后的存档名称，
 * 所以重命名实际上需要生成新的标签名。
 * 
 * @param {string} oldTagName - 旧的存档标签名
 * @param {string} newName - 新的存档名称
 * @param {string} description - 新的存档描述
 * @returns {Promise<object>}
 */
async function renameSave(oldTagName, newName, description) {
    try {
        currentOperation = 'rename_save';
        console.log(`[cloud-saves] 正在重命名存档: ${oldTagName} -> ${newName}`);
        const git = await getGitInstance();
        const config = await readConfig();

        // 验证旧标签存在
        const tags = await git.tags(['-l', oldTagName]);
        if (!tags || !tags.all.includes(oldTagName)) {
            return { success: false, message: '找不到指定的存档标签' };
        }
        // 获取旧标签对应的提交哈希
        const commit = await git.revparse([oldTagName]);
        if (!commit) return { success: false, message: '获取存档提交失败' };

        // 解码旧标签中的存档名称
        let oldDecodedName = oldTagName;
        const oldNameMatch = oldTagName.match(/^save_\d+_(.+)$/);
        if (oldNameMatch) {
            try { oldDecodedName = Buffer.from(oldNameMatch[1], 'base64url').toString('utf8'); } catch (e) {}
        }

        const nowTimestamp = new Date().toISOString();
        const newDescription = description || `存档: ${newName}`;
        const fullNewMessage = `${newDescription}\nLast Updated: ${nowTimestamp}`;

        if (oldDecodedName === newName) {
            // === 名称相同：原地更新标签信息 ===
            await git.tag(['-a', '-f', oldTagName, '-m', fullNewMessage, commit]);
            await git.push(['origin', oldTagName, '--force']);  // 强制推送更新
            return { 
                success: true, 
                message: '存档描述和更新时间已更新', 
                oldTag: oldTagName, 
                newTag: oldTagName, 
                newName: newName 
            };
        } else {
            // === 名称不同：创建新标签并删除旧标签 ===
            const encodedNewName = Buffer.from(newName).toString('base64url');
            const newTagName = `save_${Date.now()}_${encodedNewName}`;

            // 1. 创建新标签（指向相同的提交）
            await git.addAnnotatedTag(newTagName, fullNewMessage, commit);
            
            // 2. 推送新标签
            try {
                await git.push('origin', newTagName);
            } catch (pushError) {
                // 推送失败时回滚本地新标签
                await git.tag(['-d', newTagName]);
                throw pushError;
            }

            // 3. 删除旧标签
            await git.tag(['-d', oldTagName]);
            try {
                await git.push(['origin', `:refs/tags/${oldTagName}`]);
            } catch (e) {}

            // 4. 更新 current_save 引用
            if (config.current_save && config.current_save.tag === oldTagName) {
                config.current_save.tag = newTagName;
                await saveConfig(config);
            }

            return { 
                success: true, 
                message: '存档重命名成功', 
                oldTag: oldTagName, 
                newTag: newTagName, 
                newName: newName 
            };
        }
    } catch (error) {
        return handleGitError(error, `重命名存档 ${oldTagName} -> ${newName}`);
    } finally {
        currentOperation = null;
    }
}

// =========================== 存档差异对比 ===========================

/**
 * getSaveDiff - 获取两个存档（或引用）之间的文件差异
 * 
 * 使用 git diff --name-status 获取变更的文件列表和变更类型。
 * 
 * 特殊处理：
 *   如果 ref1 是空树哈希（4b825dc...），表示与"空状态"对比，
 *   使用 git ls-tree 获取 ref2 的所有文件（相当于"新建"所有文件）。
 * 
 * 空树哈希是 Git 中一个特殊的 SHA-1 值，代表一个没有任何内容的提交。
 * 
 * @param {string} ref1 - 第一个引用（标签名、分支名或提交哈希）
 * @param {string} ref2 - 第二个引用
 * @returns {Promise<object>} - { success, changedFiles: [{status, fileName}] }
 */
async function getSaveDiff(ref1, ref2) {
    try {
        currentOperation = 'get_save_diff';
        const git = simpleGit(DATA_DIR);
        const emptyTreeHash = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';  // Git 空树哈希

        // 验证 ref1 是否存在（特殊处理空树哈希）
        try {
            await git.revparse(['--verify', ref1]);
        } catch (error) {
            if ((ref1.endsWith('^') || ref1.endsWith('~1')) && error.message.includes('unknown revision')) {
                ref1 = emptyTreeHash;
            } else if (ref1 === emptyTreeHash) {
                // 确认是空树哈希
            } else {
                return { success: false, message: `找不到或无效的引用: ${ref1}`, details: error.message };
            }
        }
        // 验证 ref2 是否存在
        try {
            await git.revparse(['--verify', ref2]);
        } catch (error) {
            return { success: false, message: `找不到或无效的引用: ${ref2}`, details: error.message };
        }

        let diffOutput;
        try {
            if (ref1 === emptyTreeHash) {
                // 与空树对比：列出 ref2 的所有文件（都是新增的）
                const lsTreeOutput = await git.raw('ls-tree', '-r', '--name-only', ref2);
                if (!lsTreeOutput) return { success: true, changedFiles: [] };
                const changedFiles = lsTreeOutput.trim().split('\n').filter(Boolean).map(fileName => ({
                    status: 'A',      // A = Added（新增）
                    fileName: fileName
                }));
                return { success: true, changedFiles: changedFiles };
            } else {
                // 普通对比：使用 git diff --name-status
                diffOutput = await git.diff(['--name-status', ref1, ref2]);
            }
        } catch (diffError) {
            return handleGitError(diffError, `获取差异 ${ref1} <-> ${ref2}`);
        }

        // 解析 diff 输出：每行格式为 "<status>\t<filename>"
        // status 可能的值：A（新增）、M（修改）、D（删除）、R（重命名）、C（复制）
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

// =========================== Git 状态查询 ===========================

/**
 * getGitStatus - 获取当前 data 目录的 Git 工作区状态
 * 
 * 返回的信息包括：
 *   - initialized: 是否已初始化 Git 仓库
 *   - changes: 变更文件列表（状态+路径）
 *   - currentBranch: 当前分支（detached 状态下为 null）
 *   - currentSave: 当前加载的存档信息
 *   - isDetached: 是否处于 detached HEAD 状态
 *   - ahead/behind: 与远程仓库的提交领先/落后数量
 * 
 * 特殊处理：
 *   在没有活跃操作时，会先屏蔽嵌套 Git 目录再获取状态，
 *   这样可以显示那些包含了嵌套 Git 目录的插件的变更情况。
 * 
 * @returns {Promise<object>} - 格式化的状态对象
 */
async function getGitStatus() {
    try {
        const git = simpleGit(DATA_DIR);
        const isInitialized = await isGitInitialized();

        let status = null;
        if (isInitialized) {
            if (!currentOperation) {
                // 没有活跃操作时：先屏蔽嵌套 Git 目录，获取真实状态，再恢复
                const extensionsPath = path.join(DATA_DIR, 'default-user', 'extensions');
                let maskedPaths = await maskNestedGit(extensionsPath);
                try {
                    status = await git.status();
                } finally {
                    await unmaskNestedGit(maskedPaths);
                }
            } else {
                // 有活跃操作时：直接获取状态（不干扰正在进行的操作）
                status = await git.status();
            }
        }

        // 获取分支信息
        let currentBranch = null;
        let isDetached = false;
        if (isInitialized) {
            try {
                const branchSummary = await git.branch();
                currentBranch = branchSummary.current;
                isDetached = branchSummary.detached;  // git checkout 到特定提交时会出现
            } catch (branchError) {}
        }

        const config = await readConfig();
        const currentSave = config.current_save;

        // 格式化状态信息
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

/**
 * hasUnsavedChanges - 检查是否有未保存的更改
 * 
 * 与 getGitStatus 类似的处理逻辑：
 * 先屏蔽嵌套 Git 目录再检查状态，获取真实的工作区状态。
 * 
 * @returns {Promise<boolean>}
 */
async function hasUnsavedChanges() {
    try {
        const git = simpleGit(DATA_DIR);
        if (!await isGitInitialized()) return false;

        let isClean = true;
        if (!currentOperation) {
            // 没有活跃操作：先屏蔽再检查
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

// =========================== 临时 Stash 管理 ===========================

/**
 * checkTempStash - 检查是否存在加载存档前自动创建的临时 stash
 * 
 * 加载存档时如果用户有未保存的更改，插件会自动创建 stash 来保护这些更改。
 * 此函数检查这个 stash 是否还存在（用户可能已经处理了）。
 * 
 * @returns {Promise<object>} - { exists: boolean }
 */
async function checkTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) return { exists: false };

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        // stash 列表为空
        if (stashList.total === 0) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { exists: false };
        }
        // 查找带有特定消息的 stash
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

/**
 * applyTempStash - 应用（恢复）临时 stash
 * 
 * 将加载存档时自动保存的临时更改恢复到工作区。
 * 应用成功后删除该 stash。
 * 
 * @returns {Promise<object>}
 */
async function applyTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        // 找到对应的 stash 索引
        const stashIndex = stashList.all.findIndex(
            s => s.message && s.message.includes(stashMessageToFind)
        );

        if (stashIndex === -1) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: false, message: `Stash not found in list` };
        }

        const stashRef = `stash@{${stashIndex}}`;
        await git.stash(['apply', stashRef]);  // 应用 stash

        // 应用后删除 stash
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

/**
 * discardTempStash - 丢弃临时 stash（不应用更改）
 * 
 * 直接删除加载存档时创建的临时 stash，放弃那些未保存的更改。
 * 
 * @returns {Promise<object>}
 */
async function discardTempStash() {
    const config = await readConfig();
    if (!config.has_temp_stash) {
        return { success: false, message: 'No temporary stash found in config' };
    }

    try {
        const git = simpleGit(DATA_DIR);
        const stashList = await git.stashList();

        const stashMessageToFind = 'Temporary stash before loading save';
        const stashIndex = stashList.all.findIndex(
            s => s.message && s.message.includes(stashMessageToFind)
        );

        if (stashIndex === -1) {
            config.has_temp_stash = false;
            await saveConfig(config);
            return { success: true, message: `Stash already gone` };
        }

        const stashRef = `stash@{${stashIndex}}`;
        await git.stash(['drop', stashRef]);  // 直接删除 stash

        config.has_temp_stash = false;
        await saveConfig(config);

        return { success: true, message: 'Temporary stash discarded' };
    } catch (error) {
        return handleGitError(error, '丢弃临时Stash');
    }
}

// =========================== 定时自动存档 ===========================

/**
 * performAutoSave - 执行一次自动存档操作
 * 
 * 支持两种模式：
 * 
 *   1. 覆盖模式 (overwrite)：
 *      将当前工作区提交并强制更新指定的存档标签。
 *      适用于"保持一个定期更新的备份"场景。
 *      流程：屏蔽嵌套Git → 暂存 → 提交 → 推送 → 删除旧标签 → 创建新标签 → 推送标签
 * 
 *   2. 创建模式 (create)：
 *      像正常手动存档一样创建新标签。
 *      命名格式：YYYY-MM-DD - HHMM (Auto Save)
 *      使用浏览器时区偏移量来调整时间。
 * 
 * 安全保护：
 *   - 如果当前有其他操作在执行，跳过本次自动存档
 *   - 如果未授权或未启用自动存档，直接退出
 *   - 覆盖模式必须配置目标标签名
 * 
 * @returns {Promise<void>}
 */
async function performAutoSave() {
    // 如果有其他操作在执行，跳过本次自动存档
    if (currentOperation) return;
    currentOperation = 'auto_save';
    
    let config;
    let git;
    try {
        config = await readConfig();
        // 未授权或未启用则跳过
        if (!config.is_authorized || !config.autoSaveEnabled) {
            currentOperation = null;
            return;
        }

        const mode = config.autoSaveMode || 'overwrite';

        // ======== 创建模式 ========
        if (mode === 'create') {
            const offsetMinutes = config.autoSaveTimezoneOffset || 0;
            // 根据浏览器时区偏移调整服务器 UTC 时间
            const adjustedTime = new Date(Date.now() + offsetMinutes * 60 * 1000);
            const year = adjustedTime.getUTCFullYear();
            const month = String(adjustedTime.getUTCMonth() + 1).padStart(2, '0');
            const day = String(adjustedTime.getUTCDate()).padStart(2, '0');
            const hours = String(adjustedTime.getUTCHours()).padStart(2, '0');
            const minutes = String(adjustedTime.getUTCMinutes()).padStart(2, '0');
            const saveName = `${year}-${month}-${day} - ${hours}${minutes} (Auto Save)`;
            
            console.log(`[Cloud Saves Auto] 创建模式: 自动创建新存档 "${saveName}"`);
            
            // 临时清除 currentOperation 以便调用 createSave
            currentOperation = null;
            try {
                const result = await createSave(saveName, 'Auto Save');
                if (result.success) {
                    console.log(`[Cloud Saves Auto] 成功创建自动存档: ${result.saveData?.tag}`);
                } else {
                    console.error(`[Cloud Saves Auto] 创建自动存档失败: ${result.message}`);
                }
            } catch (createError) {
                console.error(`[Cloud Saves Auto] 创建自动存档异常:`, createError);
            }
            return;
        }

        // ======== 覆盖模式 ========
        if (!config.autoSaveTargetTag) {
            console.log('[Cloud Saves Auto] 覆盖模式需要目标标签，但未设置');
            currentOperation = null;
            return;
        }

        const targetTag = config.autoSaveTargetTag;
        console.log(`[Cloud Saves Auto] 开始自动覆盖存档到: ${targetTag}`);
        git = await getGitInstance();
        const branchToUse = config.branch || DEFAULT_BRANCH;

        // 尝试读取原有标签描述
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
            // 屏蔽嵌套 Git 目录
            maskedPaths = await maskNestedGit(extensionsPath);
            await removeGitlinksFromIndex(git, 'default-user/extensions/');

            // 暂存并提交
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

        // 删除旧标签（本地和远程）
        try { await git.tag(['-d', targetTag]); } catch (delLocalErr) {}
        try { await git.push(['origin', `:refs/tags/${targetTag}`]); } catch (delRemoteErr) {}

        // 创建新标签指向新的提交
        const nowTimestampOverwrite = new Date().toISOString();
        const fullTagMessageOverwrite = `${originalDescription}\nLast Updated: ${nowTimestampOverwrite}`;
        await git.addAnnotatedTag(targetTag, fullTagMessageOverwrite, newCommitHash);

        // 推送新标签
        try {
            await git.push('origin', targetTag);
        } catch (pushTagError) {
            // 推送失败：清理本地标签
            await git.tag(['-d', targetTag]);
            throw pushTagError;
        }
        console.log(`[Cloud Saves Auto] 成功自动覆盖存档: ${targetTag}`);

    } catch (error) {
        console.error(`[Cloud Saves Auto] 自动存档失败 (mode: ${config?.autoSaveMode}, tag: ${config?.autoSaveTargetTag}):`, error);
    } finally {
        currentOperation = null;
    }
}

/**
 * setupBackendAutoSaveTimer - 设置/重建后端定时存档计时器
 * 
 * 逻辑：
 *   1. 清除现有的计时器（如果有）
 *   2. 读取配置，检查是否启用了自动存档
 *   3. 覆盖模式需要目标标签，否则不启动
 *   4. 计算间隔时间（最小 1 分钟，默认 30 分钟）
 *   5. 使用 setInterval 创建新的定时器
 * 
 * 注意：当配置更改时需要调用此函数来更新定时器
 */
function setupBackendAutoSaveTimer() {
    // 清除现有定时器
    if (autoSaveBackendTimer) {
        clearInterval(autoSaveBackendTimer);
        autoSaveBackendTimer = null;
    }

    // 读取配置并决定是否启动新定时器
    readConfig().then(config => {
        if (config.is_authorized && config.autoSaveEnabled) {
            const mode = config.autoSaveMode || 'overwrite';
            // 覆盖模式需要 targetTag
            if (mode === 'overwrite' && !config.autoSaveTargetTag) {
                console.log('[Cloud Saves] 覆盖模式需要目标标签，自动存档定时器不会启动');
                return;
            }
            // 计算间隔（毫秒），确保最少 1 分钟
            let intervalMilliseconds = (config.autoSaveInterval > 0 ? config.autoSaveInterval : 30) * 60 * 1000;
            if (intervalMilliseconds < 60000) intervalMilliseconds = 60000;
            
            autoSaveBackendTimer = setInterval(performAutoSave, intervalMilliseconds);
            console.log(`[Cloud Saves] 自动存档定时器已启动 (模式: ${mode}, 间隔: ${config.autoSaveInterval}分钟)`);
        }
    }).catch(err => {
        console.error('[Cloud Saves] 启动后端定时器前读取配置失败:', err);
    });
}

// =========================== 插件初始化 (主入口) ===========================

/**
 * init - 插件初始化函数
 * 
 * 这是 SillyTavern 加载插件时调用的主函数。
 * 负责注册所有 HTTP API 路由端点。
 * 
 * API 端点列表：
 * 
 *   插件元信息：
 *     GET  /info                    - 获取插件元信息
 *   
 *   配置管理：
 *     GET  /config                  - 获取当前配置（隐藏敏感信息）
 *     POST /config                  - 更新配置
 *   
 *   授权：
 *     POST /authorize               - 授权并连接 GitHub 仓库
 *   
 *   状态查询：
 *     GET  /status                  - 获取 Git 仓库状态
 *   
 *   存档操作：
 *     GET  /saves                   - 获取存档列表
 *     POST /saves                   - 创建新存档
 *     POST /saves/load              - 加载存档
 *     DELETE /saves/:tagName        - 删除存档
 *     PUT  /saves/:oldTagName       - 重命名存档
 *     GET  /saves/diff              - 获取两个存档的差异
 *     POST /saves/:tagName/overwrite - 覆盖已有存档
 *   
 *   Stash 管理：
 *     POST /stash/apply             - 应用临时 stash
 *     POST /stash/discard           - 丢弃临时 stash
 *   
 *   工具：
 *     POST /update/check-and-pull   - 检查并拉取插件更新
 *     POST /initialize              - 强制重新初始化仓库
 * 
 * @param {object} router - SillyTavern 注入的 Express 路由器
 */
async function init(router) {
    console.log('[cloud-saves] 初始化云存档插件 (simple-git)...');
    console.log('[cloud-saves] 插件 UI 访问地址 (如果端口不是8000请自行修改): http://127.0.0.1:8000/api/plugins/cloud-saves/ui');

    try {
        // ======== 静态文件与基本路由 ========
        // 提供 public 目录下的静态文件（CSS、JS 等）
        router.use('/static', express.static(path.join(__dirname, 'public')));
        // 解析 JSON 请求体
        router.use(express.json());

        // 插件 UI 页面
        router.get('/ui', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        // ======== 插件信息 ========
        router.get('/info', (req, res) => {
            res.json(info);
        });

        // ======== 配置读取 ========
        router.get('/config', async (req, res) => {
            try {
                const config = await readConfig();
                // 返回安全的配置信息（隐藏敏感数据如 github_token）
                const safeConfig = {
                    repo_url: config.repo_url || '',
                    display_name: config.display_name || '',
                    branch: config.branch || DEFAULT_BRANCH,
                    is_authorized: config.is_authorized || false,
                    username: config.username || null,
                    autoSaveEnabled: config.autoSaveEnabled || false,
                    autoSaveInterval: config.autoSaveInterval || 30,
                    autoSaveTargetTag: config.autoSaveTargetTag || '',
                    autoSaveMode: config.autoSaveMode || 'overwrite',
                    autoSaveTimezoneOffset: config.autoSaveTimezoneOffset || 0,
                    has_github_token: !!config.github_token,  // 只告知是否存在 token
                };
                res.json(safeConfig);
            } catch (error) {
                res.status(500).json({ success: false, message: '读取配置失败', error: error.message });
            }
        });

        // ======== 配置更新 ========
        router.post('/config', async (req, res) => {
            try {
                const {
                    repo_url, github_token, display_name, branch, is_authorized,
                    autoSaveEnabled, autoSaveInterval, autoSaveTargetTag, 
                    autoSaveMode, autoSaveTimezoneOffset
                } = req.body;
                let currentConfig = await readConfig();

                // 逐一更新配置字段（只有请求体中有的字段才更新）
                currentConfig.repo_url = repo_url !== undefined ? repo_url.trim() : currentConfig.repo_url;
                if (github_token) currentConfig.github_token = github_token;
                currentConfig.display_name = display_name !== undefined ? display_name.trim() : currentConfig.display_name;
                currentConfig.branch = branch !== undefined ? (branch.trim() || DEFAULT_BRANCH) : currentConfig.branch;
                if (is_authorized !== undefined) currentConfig.is_authorized = !!is_authorized;
                if (autoSaveEnabled !== undefined) currentConfig.autoSaveEnabled = !!autoSaveEnabled;
                
                // 验证自动存档间隔
                if (autoSaveInterval !== undefined) {
                    const interval = parseFloat(autoSaveInterval);
                    if (isNaN(interval) || interval <= 0) {
                        return res.status(400).json({ success: false, message: '无效的自动存档间隔。' });
                    }
                    currentConfig.autoSaveInterval = interval;
                }
                
                if (autoSaveTargetTag !== undefined) currentConfig.autoSaveTargetTag = autoSaveTargetTag.trim();
                if (autoSaveMode !== undefined) currentConfig.autoSaveMode = autoSaveMode;
                if (autoSaveTimezoneOffset !== undefined) currentConfig.autoSaveTimezoneOffset = parseInt(autoSaveTimezoneOffset) || 0;

                await saveConfig(currentConfig);
                // 配置更新后重建定时器
                setupBackendAutoSaveTimer();

                // 返回安全配置
                const safeConfig = {
                    repo_url: currentConfig.repo_url,
                    display_name: currentConfig.display_name,
                    branch: currentConfig.branch,
                    is_authorized: currentConfig.is_authorized,
                    username: currentConfig.username,
                    autoSaveEnabled: currentConfig.autoSaveEnabled,
                    autoSaveInterval: currentConfig.autoSaveInterval,
                    autoSaveTargetTag: currentConfig.autoSaveTargetTag,
                    autoSaveMode: currentConfig.autoSaveMode,
                    autoSaveTimezoneOffset: currentConfig.autoSaveTimezoneOffset
                };
                res.json({ success: true, message: '配置保存成功', config: safeConfig });
            } catch (error) {
                res.status(500).json({ success: false, message: '保存配置失败', error: error.message });
            }
        });

        // ======== 授权端点 ========
        router.post('/authorize', async (req, res) => {
            let authGit;
            try {
                const { branch } = req.body;
                let config = await readConfig();
                const targetBranch = branch || config.branch || DEFAULT_BRANCH;

                // 验证必要配置
                if (!config.repo_url || !config.github_token) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '仓库URL和GitHub Token未配置' 
                    });
                }

                if (branch && config.branch !== targetBranch) config.branch = targetBranch;
                config.is_authorized = false;

                // 初始化 Git 仓库
                const initResult = await initGitRepo();
                if (!initResult.success) {
                    return res.status(500).json({ 
                        success: false, 
                        message: initResult.message, 
                        details: initResult.details 
                    });
                }
                
                authGit = simpleGit(DATA_DIR);

                // 如果有未追踪的文件，创建初始提交
                try {
                    await authGit.add('.');
                    const status = await authGit.status();
                    if (!status.isClean()) {
                        // 设置 Git 用户名和邮箱（仅在本地有效）
                        try {
                            await authGit.addConfig('user.name', 'Cloud Saves Plugin', false, 'local');
                            await authGit.addConfig('user.email', 'cloud-saves@plugin.local', false, 'local');
                        } catch (configError) {}
                        await authGit.commit('Initial commit of existing data directory');
                    }
                } catch (initialCommitError) {}

                // 配置远程仓库 URL（嵌入认证 token）
                let authUrl = config.repo_url;
                if (config.repo_url.startsWith('https://') && !config.repo_url.includes('@')) {
                    authUrl = config.repo_url.replace('https://', 
                        `https://x-access-token:${config.github_token}@`);
                }
                const remotes = await authGit.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin) {
                    if (origin.refs.push !== authUrl) await authGit.remote(['set-url', 'origin', authUrl]);
                } else {
                    await authGit.addRemote('origin', authUrl);
                }

                // 尝试拉取远程仓库（验证连接和权限）
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
                
                // 检查远程分支是否存在
                let remoteBranchExists = false;
                try {
                    const remoteHeads = await authGit.listRemote(['--heads', 'origin', targetBranch]);
                    remoteBranchExists = typeof remoteHeads === 'string' && 
                                        remoteHeads.includes(`refs/heads/${targetBranch}`);
                } catch (lsRemoteError) {}

                // 如果远程分支不存在，创建并推送
                if (!remoteBranchExists) {
                    try {
                        const localBranches = await authGit.branchLocal();
                        if (!localBranches.all.includes(targetBranch)) {
                            await authGit.checkout(['-b', targetBranch]);
                        } else {
                            await authGit.checkout(targetBranch);
                        }
                        await authGit.push(['--set-upstream', 'origin', targetBranch]);
                    } catch (createBranchError) {
                        await saveConfig(config);
                        return res.status(500).json({ 
                            success: false, 
                            message: `无法建立同步分支 ${targetBranch}`, 
                            details: createBranchError.message 
                        });
                    }
                }

                // 标记授权成功
                config.is_authorized = true;
                config.branch = targetBranch;

                // 通过 GitHub API 验证 token 并获取用户名
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
                // 启动自动存档定时器
                setupBackendAutoSaveTimer();

                // 返回安全配置
                const safeConfig = {
                    repo_url: config.repo_url,
                    display_name: config.display_name,
                    branch: config.branch,
                    is_authorized: config.is_authorized,
                    username: config.username,
                    autoSaveEnabled: config.autoSaveEnabled,
                    autoSaveInterval: config.autoSaveInterval,
                    autoSaveTargetTag: config.autoSaveTargetTag,
                    autoSaveMode: config.autoSaveMode,
                    autoSaveTimezoneOffset: config.autoSaveTimezoneOffset
                };

                res.json({ success: true, message: '授权和配置成功', config: safeConfig });

            } catch (error) {
                // 错误处理：取消授权标记
                try {
                    let cfg = await readConfig();
                    cfg.is_authorized = false;
                    await saveConfig(cfg);
                } catch (saveErr) {}
                res.status(500).json({ 
                    success: false, 
                    message: '授权过程中发生错误', 
                    error: error.message 
                });
            }
        });

        // ======== 状态查询 ========
        router.get('/status', async (req, res) => {
            try {
                const status = await getGitStatus();
                const tempStashStatus = await checkTempStash();
                res.json({ 
                    success: true, 
                    status: { ...status, tempStash: tempStashStatus } 
                });
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: error.message || '获取状态失败', 
                    details: error.details 
                });
            }
        });

        // ======== 存档列表 ========
        router.get('/saves', async (req, res) => {
            // 如果有操作正在执行，返回 409 冲突
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const result = await listSaves();
                res.json(result);
            } catch (error) {
                res.status(500).json(error);
            }
        });

        // ======== 创建存档 ========
        router.post('/saves', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const { name, description } = req.body;
                if (!name) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '需要提供存档名称' 
                    });
                }
                const result = await createSave(name, description);
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '创建存档时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 加载存档 ========
        router.post('/saves/load', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const { tagName } = req.body;
                if (!tagName) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '需要提供存档标签名' 
                    });
                }
                const result = await loadSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '加载存档时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 删除存档 ========
        router.delete('/saves/:tagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const { tagName } = req.params;
                if (!tagName) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '需要提供存档标签名' 
                    });
                }
                const result = await deleteSave(tagName);
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '删除存档时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 重命名存档 ========
        router.put('/saves/:oldTagName', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const { oldTagName } = req.params;
                const { newName, description } = req.body;
                if (!oldTagName || !newName) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '需要提供旧存档标签名和新名称' 
                    });
                }
                const result = await renameSave(oldTagName, newName, description);
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '重命名存档时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 存档差异 ========
        router.get('/saves/diff', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const { tag1, tag2 } = req.query;
                if (!tag1 || !tag2) {
                    return res.status(400).json({ 
                        success: false, 
                        message: '需要提供两个存档标签名/引用' 
                    });
                }
                const result = await getSaveDiff(tag1, tag2);
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '获取存档差异时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 应用临时 Stash ========
        router.post('/stash/apply', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const result = await applyTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '应用临时Stash时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 丢弃临时 Stash ========
        router.post('/stash/discard', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const result = await discardTempStash();
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '丢弃临时Stash时发生意外错误', 
                    details: error.message 
                });
            }
        });

        // ======== 覆盖存档 ========
        router.post('/saves/:tagName/overwrite', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            currentOperation = 'overwrite_save';
            const { tagName } = req.params;
            let git;
            try {
                const config = await readConfig();
                if (!config.is_authorized) {
                    return res.status(401).json({ 
                        success: false, 
                        message: '未授权，请先连接仓库' 
                    });
                }
                
                git = await getGitInstance();
                const branchToUse = config.branch || DEFAULT_BRANCH;

                // 读取原有标签描述
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
                    // 屏蔽嵌套 Git 目录
                    maskedPaths = await maskNestedGit(extensionsPath);
                    await removeGitlinksFromIndex(git, 'default-user/extensions/');

                    // 暂存并提交
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

                // 删除旧标签并创建新标签
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
                res.status(500).json({ 
                    success: false, 
                    message: '覆盖存档时发生意外错误', 
                    details: error.message 
                });
            } finally {
                currentOperation = null;
            }
        });

        // ======== 检查并拉取插件更新 ========
        router.post('/update/check-and-pull', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                // 使用插件自身的目录作为 Git 仓库来检查更新
                const pluginGit = simpleGit(__dirname);
                const isRepo = await pluginGit.checkIsRepo();
                
                if (!isRepo) {
                    return res.json({ success: true, status: 'not_git_repo' });
                }

                await pluginGit.fetch();
                const status = await pluginGit.status();

                if (status.behind === 0) {
                    return res.json({ success: true, status: 'latest' });
                }

                // 有更新：执行拉取
                await pluginGit.pull();
                return res.json({ success: true, status: 'updated' });
            } catch (error) {
                console.error('[cloud-saves] 检查更新失败:', error);
                res.status(500).json({ 
                    success: false, 
                    message: '检查更新过程发生错误', 
                    details: error.message 
                });
            }
        });

        // ======== 强制重新初始化仓库 ========
        router.post('/initialize', async (req, res) => {
            if (currentOperation) {
                return res.status(409).json({ 
                    success: false, 
                    message: `正在进行操作: ${currentOperation}` 
                });
            }
            try {
                const gitDir = path.join(DATA_DIR, '.git');
                // 删除现有的 .git 目录以实现强制重新初始化
                await fs.rm(gitDir, { recursive: true, force: true }).catch(() => {});
                const result = await initGitRepo();
                res.json(result);
            } catch (error) {
                res.status(500).json({ 
                    success: false, 
                    message: '强制初始化仓库失败', 
                    details: error.message 
                });
            }
        });

        // ======== 启动后台自动存档定时器 ========
        setupBackendAutoSaveTimer();

    } catch (error) {
        console.error('[cloud-saves] 初始化插件期间发生错误:', error);
    }
} // 结束 init 函数

// =========================== 导出插件模块 ===========================

/**
 * 模块导出
 * SillyTavern 通过 require 加载插件，读取 info 和 init 属性。
 *   - info: 提供插件的元信息（ID、名称、描述、版本）
 *   - init: 插件初始化函数，接收 Express 路由器作为参数
 */
module.exports = {
    info,
    init
};