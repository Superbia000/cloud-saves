// 云存档前端脚本
document.addEventListener('DOMContentLoaded', function() {
    // 全局变量
    let isAuthorized = false;
    let currentSaves = [];
    let confirmCallback = null;
    let renameTarget = null;
    let initialConfigHasToken = false; // 新增：用于跟踪初始加载时是否有token

    // 获取DOM元素引用
    const authSection = document.getElementById('auth-section');
    const authForm = document.getElementById('auth-form');
    const authStatus = document.getElementById('auth-status');
    const repoUrlInput = document.getElementById('repo-url');
    const githubTokenInput = document.getElementById('github-token');
    const displayNameInput = document.getElementById('display-name');
    const branchInput = document.getElementById('branch-input');
    const configureBtn = document.getElementById('configure-btn');
    const authorizeBtn = document.getElementById('authorize-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const initRepoBtn = document.getElementById('init-repo-btn'); // 新增

    const createSaveSection = document.getElementById('create-save-section');
    const saveNameInput = document.getElementById('save-name');
    const saveDescriptionInput = document.getElementById('save-description');
    const createSaveBtn = document.getElementById('create-save-btn');

    const savesSection = document.getElementById('saves-section');
    const savesContainer = document.getElementById('saves-container');
    const noSavesMessage = document.getElementById('no-saves-message');
    const refreshSavesBtn = document.getElementById('refresh-saves-btn');
    const searchBox = document.getElementById('search-box');
    const sortSelector = document.getElementById('sort-selector');

    const stashNotification = document.getElementById('stash-notification');
    const applyStashBtn = document.getElementById('apply-stash-btn');
    const discardStashBtn = document.getElementById('discard-stash-btn');

    const gitStatus = document.getElementById('git-status');
    const changesStatus = document.getElementById('changes-status');
    const changesCount = document.getElementById('changes-count');
    const currentSaveStatus = document.getElementById('current-save-status');

    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingMessage = document.getElementById('loading-message');

    const renameModal = new bootstrap.Modal(document.getElementById('renameModal'));
    const renameTagNameInput = document.getElementById('rename-tag-name');
    const renameNewNameInput = document.getElementById('rename-new-name');
    const renameDescriptionInput = document.getElementById('rename-description');
    const confirmRenameBtn = document.getElementById('confirm-rename-btn');

    const confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    const confirmMessageText = document.getElementById('confirm-message');
    const confirmActionBtn = document.getElementById('confirm-action-btn');

    const diffModal = new bootstrap.Modal(document.getElementById('diffModal'));
    const diffSummary = document.getElementById('diff-summary');
    const diffFiles = document.getElementById('diff-files');

    // 新增：定时存档 UI 元素
    const autoSaveSection = document.getElementById('auto-save-section');
    const autoSaveEnabledSwitch = document.getElementById('auto-save-enabled');
    const autoSaveOptionsDiv = document.getElementById('auto-save-options');
    const autoSaveIntervalInput = document.getElementById('auto-save-interval');
    const autoSaveTargetTagInput = document.getElementById('auto-save-target-tag');
    const saveAutoSaveSettingsBtn = document.getElementById('save-auto-save-settings-btn');

    // 新增：检查更新按钮
    const checkUpdateBtn = document.getElementById('check-update-btn');

    // API调用工具函数
    async function apiCall(endpoint, method = 'GET', data = null) {
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // 对于非GET请求，先获取CSRF令牌
        if (method !== 'GET' && method !== 'HEAD') {
            try {
                const csrfResponse = await fetch('/csrf-token');
                if (!csrfResponse.ok) {
                    throw new Error(`获取CSRF令牌失败: ${csrfResponse.statusText}`);
                }
                const csrfData = await csrfResponse.json();
                if (!csrfData || !csrfData.token) {
                    throw new Error('无效的CSRF令牌响应');
                }
                options.headers['X-CSRF-Token'] = csrfData.token;
            } catch (csrfError) {
                console.error('无法获取或设置CSRF令牌:', csrfError);
                showToast('错误', `无法执行操作，获取安全令牌失败: ${csrfError.message}`, 'error');
                throw csrfError; // 阻止后续请求
            }
        }

        if (data && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(`/api/plugins/cloud-saves/${endpoint}`, options);
            // 检查是否是 CSRF 错误导致的 HTML 响应
            if (!response.ok && response.headers.get('content-type')?.includes('text/html')) {
                 if (response.status === 403) {
                     throw new Error('认证或权限错误 (403 Forbidden)。可能是CSRF令牌问题或GitHub Token权限不足。');
                 } else {
                    throw new Error(`请求失败，服务器返回了非JSON响应 (状态码: ${response.status})`);
                 }
            }
            
            const result = await response.json();
            
            if (!response.ok) {
                // 使用后端返回的 message 或构造一个
                throw new Error(result.message || `请求失败，状态码: ${response.status}`); 
            }
            
            return result;
        } catch (error) {
            console.error(`API调用失败 (${endpoint}):`, error);
            // 避免重复显示CSRF令牌获取失败的Toast
            if (!error.message.includes('安全令牌失败')) {
                 showToast('错误', `操作失败: ${error.message}`, 'error');
            }
            throw error;
        }
    }

    // 加载/显示函数
    function showLoading(message = '正在加载...') {
        loadingMessage.textContent = message;
        loadingOverlay.style.display = 'flex';
    }

    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    function showToast(title, message, type = 'info') {
        const toastContainer = document.querySelector('.toast-container');
        
        const toast = document.createElement('div');
        toast.classList.add('toast', 'show');
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');
        
        // 根据类型设置边框颜色
        if (type === 'success') {
            toast.style.borderLeft = '4px solid var(--bs-success)';
        } else if (type === 'error' || type === 'danger') {
            toast.style.borderLeft = '4px solid var(--bs-danger)';
        } else if (type === 'warning') {
            toast.style.borderLeft = '4px solid var(--bs-warning)';
        } else {
            toast.style.borderLeft = '4px solid var(--bs-primary)';
        }
        
        // 设置内容
        toast.innerHTML = `
            <div class="toast-header">
                <strong class="me-auto">${title}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
            <div class="toast-body">${message}</div>
        `;
        
        toastContainer.appendChild(toast);
        
        // 自动关闭
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 5000);
        
        // 点击关闭按钮
        toast.querySelector('.btn-close').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        });
    }

    // 初始化
    async function init() {
        try {
            const config = await apiCall('config');

            if (config.repo_url) repoUrlInput.value = config.repo_url;
            if (config.display_name) displayNameInput.value = config.display_name;
            if (config.branch) branchInput.value = config.branch;
            
            // --- Token Input Handling ---
            initialConfigHasToken = config.has_github_token; // 记录初始状态
            if (initialConfigHasToken) {
                githubTokenInput.placeholder = "访问令牌已保存"; // 设置提示
                githubTokenInput.value = ""; // 确保实际值为空
            } else {
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx"; // 默认提示
                githubTokenInput.value = "";
            }
            // --- End Token Input Handling ---
            
            autoSaveEnabledSwitch.checked = config.autoSaveEnabled || false;
            autoSaveIntervalInput.value = config.autoSaveInterval || 30;
            autoSaveTargetTagInput.value = config.autoSaveTargetTag || '';
            autoSaveOptionsDiv.style.display = autoSaveEnabledSwitch.checked ? 'flex' : 'none';
            
            isAuthorized = config.is_authorized;
            
            updateAuthUI(isAuthorized);
            
            if (isAuthorized) {
                await refreshStatus();
                await loadSavesList();
            }
        } catch (error) {
            // 初始化失败时，也重置 token 输入框状态
            githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
            githubTokenInput.value = "";
            initialConfigHasToken = false;
        }
    }

    // 更新授权UI (MODIFIED - 登出时重置 token 输入框)
    function updateAuthUI(authorized) {
        isAuthorized = authorized; // Update global state

        if (authorized) {
            // --- UI for Authorized State ---
            authStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>已成功授权`;
            authStatus.classList.remove('alert-danger');
            authStatus.classList.add('alert-success');
            authStatus.style.display = 'block';
            logoutBtn.style.display = 'inline-block';
            createSaveSection.style.display = 'block';
            savesSection.style.display = 'block';
            autoSaveSection.style.display = 'block';

            // Set placeholder based on whether a token is actually configured
            if (initialConfigHasToken) {
                githubTokenInput.placeholder = "访问令牌已保存";
                githubTokenInput.value = "";
            } else {
                // Edge case: Authorized but somehow no token? Should not happen.
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                githubTokenInput.value = "";
            }
        } else {
            // --- UI for Non-Authorized State ---
            authStatus.style.display = 'none';
            logoutBtn.style.display = 'none';
            createSaveSection.style.display = 'none';
            savesSection.style.display = 'none';
            autoSaveSection.style.display = 'none';

            // Set placeholder based on whether a token is configured (even if not authorized)
            if (initialConfigHasToken) {
                 // Keep showing "已保存" as a hint that backend has it
                githubTokenInput.placeholder = "访问令牌已保存";
                githubTokenInput.value = "";
            } else {
                 // No token configured, show default prompt
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                githubTokenInput.value = "";
            }
            // NOTE: DO NOT reset initialConfigHasToken here. It reflects backend state.
        }
    }

    // 刷新Git状态
    async function refreshStatus() {
        try {
            const statusResult = await apiCall('status');
            
            if (statusResult.success && statusResult.status) {
                const status = statusResult.status;
                
                // 更新Git初始化状态
                if (status.initialized) {
                    gitStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>Git仓库就绪`;
                } else {
                    gitStatus.innerHTML = `<i class="bi bi-circle-fill text-secondary me-2"></i>Git仓库未初始化`;
                }
                
                // 更新更改状态
                if (status.changes && status.changes.length > 0) {
                    changesCount.textContent = status.changes.length;
                    changesStatus.style.display = 'inline';
                } else {
                    changesStatus.style.display = 'none';
                }
                
                // 更新当前存档状态
                if (status.currentSave) {
                    const saveNameMatch = status.currentSave.tag.match(/^save_\d+_(.+)$/);
                    const saveName = saveNameMatch ? saveNameMatch[1] : status.currentSave.tag;
                    currentSaveStatus.innerHTML = `当前存档: <strong>${saveName}</strong>`;
                } else {
                    currentSaveStatus.textContent = '未加载任何存档';
                }
                
                // 检查临时stash状态
                if (status.tempStash && status.tempStash.exists) {
                    stashNotification.style.display = 'block';
                } else {
                    stashNotification.style.display = 'none';
                }
            }
        } catch (error) {
            console.error('刷新状态失败:', error);
            showToast('错误', `刷新状态失败: ${error.message}`, 'error');
        }
    }

    // 加载存档列表
    async function loadSavesList() {
        try {
            showLoading('正在获取存档列表...');
            
            const result = await apiCall('saves');
            
            if (result.success && result.saves) {
                currentSaves = result.saves;
                
                renderSavesList(currentSaves);
            } else {
                throw new Error(result.message || '获取存档列表失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('加载存档列表失败:', error);
            showToast('错误', `加载存档列表失败: ${error.message}`, 'error');
        }
    }

    // 渲染存档列表
    function renderSavesList(saves) {
        // 先清空容器
        while (savesContainer.firstChild) {
            savesContainer.removeChild(savesContainer.firstChild);
        }
        
        // 检查是否有存档
        if (saves.length === 0) {
            savesContainer.appendChild(noSavesMessage);
            return;
        }
        
        // 获取当前加载的存档
        let currentLoadedSave = null;
        
        apiCall('config').then(config => {
            if (config.current_save && config.current_save.tag) {
                currentLoadedSave = config.current_save.tag;
                
                // 更新已渲染的存档卡片
                const currentSaveCard = document.querySelector(`.save-card[data-tag="${currentLoadedSave}"]`);
                if (currentSaveCard) {
                    const badge = document.createElement('div');
                    badge.classList.add('save-current-badge');
                    badge.textContent = '当前存档';
                    currentSaveCard.appendChild(badge);
                }
            }
        });
        
        // 创建存档卡片
        saves.forEach(save => {
            const saveCard = document.createElement('div');
            saveCard.classList.add('card', 'save-card', 'mb-3');
            saveCard.dataset.tag = save.tag;
            
            const saveDate = new Date(save.timestamp);
            const formattedDate = saveDate.toLocaleString();
            
            // 使用新的时间戳字段
            const createdAtDate = new Date(save.createdAt);
            const updatedAtDate = new Date(save.updatedAt);
            const formattedCreatedAt = createdAtDate.toLocaleString();
            const formattedUpdatedAt = updatedAtDate.toLocaleString();
            const descriptionText = save.description || '无描述';
            const creatorName = save.creator || '未知';
            
            saveCard.innerHTML = `
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start">
                        <div style="flex-grow: 1; margin-right: 15px;">
                            <h5 class="card-title mb-1">${save.name}</h5>
                            <div class="save-timestamp mb-1">
                                <small>创建于: ${formattedCreatedAt} | 更新于: ${formattedUpdatedAt}</small>
                            </div>
                            <div class="save-creator mb-2">操作人: ${creatorName}</div>
                            <div class="save-description">${descriptionText}</div>
                            <!-- 新增：显示并可复制标签名 -->
                            <div class="save-tag-info mt-2">
                                <small class="text-muted">标签名: <code class="user-select-all">${save.tag}</code></small>
                                <button class="btn btn-sm btn-outline-secondary copy-tag-btn ms-1" data-tag="${save.tag}" title="复制标签名">
                                    <i class="bi bi-clipboard"></i>
                                </button>
                            </div>
                        </div>
                        <div class="action-buttons flex-shrink-0">
                            <button class="btn btn-sm btn-primary rename-save-btn" data-tag="${save.tag}" data-name="${save.name}" data-description="${descriptionText}" title="重命名此存档">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <button class="btn btn-sm btn-success load-save-btn" data-tag="${save.tag}" title="加载此存档">
                                <i class="bi bi-cloud-download"></i>
                            </button>
                            <button class="btn btn-sm btn-warning overwrite-save-btn" data-tag="${save.tag}" data-name="${save.name}" title="用当前本地数据覆盖此云存档">
                                <i class="bi bi-upload"></i>
                            </button>
                            <button class="btn btn-sm btn-outline-info diff-save-btn" data-tag="${save.tag}" data-name="${save.name}" title="比较差异">
                                <i class="bi bi-file-diff"></i>
                            </button>
                            <button class="btn btn-sm btn-danger delete-save-btn" data-tag="${save.tag}" title="删除此存档">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            // 如果是当前加载的存档，添加标记
            if (save.tag === currentLoadedSave) {
                const badge = document.createElement('div');
                badge.classList.add('save-current-badge');
                badge.textContent = '当前存档';
                saveCard.appendChild(badge);
            }
            
            savesContainer.appendChild(saveCard);
        });
        
        // 注册按钮事件
        registerSaveCardEvents();
    }
    
    // 注册存档卡片按钮事件
    function registerSaveCardEvents() {
        // 加载存档按钮
        document.querySelectorAll('.load-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                showConfirmDialog(
                    `确认加载存档`,
                    `您确定要加载此存档吗？所有当前未保存的更改将被暂存。`,
                    async () => {
                        await loadSave(tagName);
                    }
                );
            });
        });
        
        // 重命名存档按钮
        document.querySelectorAll('.rename-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                renameTarget = this.dataset.tag;
                renameTagNameInput.value = renameTarget;
                renameNewNameInput.value = this.dataset.name || '';
                renameDescriptionInput.value = this.dataset.description || '';
                renameModal.show();
            });
        });
        
        // 覆盖存档按钮
        document.querySelectorAll('.overwrite-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                const saveName = this.dataset.name || tagName; // 获取存档名用于提示
                showConfirmDialog(
                    `确认覆盖存档 "${saveName}"`,
                    `<strong>警告：此操作不可逆！</strong><br>您确定要用当前本地的 SillyTavern 数据覆盖云端的 "${saveName}" 存档吗？云端该存档之前的内容将会丢失。`,
                    async () => {
                        await overwriteSave(tagName);
                    },
                    'danger' // 使用危险确认按钮样式
                );
            });
        });
        
        // 删除存档按钮
        document.querySelectorAll('.delete-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                showConfirmDialog(
                    `确认删除存档`,
                    `您确定要删除此存档吗？此操作无法撤销。`,
                    async () => {
                        await deleteSave(tagName);
                    }
                );
            });
        });
        
        // 比较差异按钮
        document.querySelectorAll('.diff-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                // 再次尝试获取存档名称，添加日志调试
                const saveName = this.dataset.name;
                console.log('Comparing save:', tagName, 'Name from dataset:', saveName);
                if (!saveName) {
                    console.error('Could not retrieve save name from button dataset!');
                }
                
                try {
                    showLoading('正在加载差异...');
                    
                    // --- BEGIN REVERT DIFF LOGIC ---
                    // 恢复为比较标签和当前 HEAD
                    const tagRef1 = encodeURIComponent(tagName);
                    const tagRef2 = 'HEAD'; // 直接使用 HEAD
                    const result = await apiCall(`saves/diff?tag1=${tagRef1}&tag2=${tagRef2}`);
                    // --- END REVERT DIFF LOGIC ---
                    
                    if (result.success) {
                        // 更新模态框标题，确保 saveName 有值
                        const diffModalLabel = document.getElementById('diffModalLabel');
                        diffModalLabel.textContent = `存档 "${saveName || tagName}" 与当前状态的差异`; // 使用 tagname 作为备用
                        
                        // 隐藏统计信息区域 (保持不变)
                        diffSummary.innerHTML = ''; 
                        diffSummary.style.display = 'none'; 
                        
                        diffFiles.innerHTML = '';
                        if (result.changedFiles && result.changedFiles.length > 0) {
                           const fileList = document.createElement('ul');
                            fileList.classList.add('list-unstyled'); 
                            result.changedFiles.forEach(file => {
                                const li = document.createElement('li');
                                li.classList.add('mb-1');
                                let statusText = '';
                                let statusClass = '';
                                let statusIcon = ''; 
                                switch (file.status.charAt(0)) {
                                    case 'A': statusText = '添加'; statusClass = 'text-success'; statusIcon = '<i class="bi bi-plus-circle-fill me-2"></i>'; break;
                                    case 'M': statusText = '修改'; statusClass = 'text-warning'; statusIcon = '<i class="bi bi-pencil-fill me-2"></i>'; break;
                                    case 'D': statusText = '删除'; statusClass = 'text-danger'; statusIcon = '<i class="bi bi-trash-fill me-2"></i>'; break;
                                    case 'R': statusText = '重命名'; statusClass = 'text-info'; statusIcon = '<i class="bi bi-arrow-left-right me-2"></i>'; break;
                                    case 'C': statusText = '复制'; statusClass = 'text-info'; statusIcon = '<i class="bi bi-files me-2"></i>'; break;
                                    default: statusText = file.status; statusClass = 'text-secondary'; statusIcon = '<i class="bi bi-question-circle-fill me-2"></i>';
                                }
                                li.innerHTML = `<span class="${statusClass}" style="display: inline-block; width: 60px;">${statusIcon}${statusText}</span><code>${file.fileName}</code>`;
                                fileList.appendChild(li);
                            });
                            diffFiles.appendChild(fileList);
                        } else {
                            diffFiles.innerHTML = '<p class="text-center text-secondary mt-3">此存档与当前状态没有文件差异。</p>'; // 更新无差异消息
                        }
                        
                        hideLoading();
                        diffModal.show();
                    } else {
                        throw new Error(result.message || '获取差异失败');
                    }
                } catch (error) {
                    hideLoading();
                    console.error('获取差异失败:', error);
                    showToast('错误', `获取差异失败: ${error.message}`, 'error');
                }
            });
        });

        // --- 新增：复制标签名按钮事件 ---
        document.querySelectorAll('.copy-tag-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                navigator.clipboard.writeText(tagName).then(() => {
                    // 短暂改变图标提示成功
                    const icon = this.querySelector('i');
                    const originalIconClass = icon.className;
                    icon.className = 'bi bi-check-lg text-success'; 
                    showToast('提示', '标签名已复制到剪贴板', 'info');
                    setTimeout(() => {
                        icon.className = originalIconClass;
                    }, 1500); // 1.5秒后恢复图标
                }).catch(err => {
                    console.error('复制标签名失败:', err);
                    showToast('错误', '复制标签名失败', 'error');
                });
            });
        });
    }

    // 加载存档
    async function loadSave(tagName) {
        try {
            showLoading('正在加载存档...');
            
            const result = await apiCall('saves/load', 'POST', { tagName });
            
            if (result.success) {
                showToast('成功', '存档加载成功', 'success');
                await refreshStatus();
                // 高亮显示逻辑不需要改变
                highlightCurrentSave(tagName);
            } else {
                throw new Error(result.message || '加载存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('加载存档失败:', error);
            showToast('错误', `加载存档失败: ${error.message}`, 'error');
        }
    }

    // --- 新增：高亮当前存档的辅助函数 ---
    function highlightCurrentSave(tagName) {
        document.querySelectorAll('.save-current-badge').forEach(badge => badge.remove());
        const saveCard = document.querySelector(`.save-card[data-tag="${tagName}"]`);
        if (saveCard) {
            const badge = document.createElement('div');
            badge.classList.add('save-current-badge');
            badge.textContent = '当前存档';
            saveCard.appendChild(badge);
        }
    }

    // 删除存档
    async function deleteSave(tagName) {
        try {
            showLoading('正在删除存档...');
            
            const result = await apiCall(`saves/${tagName}`, 'DELETE');
            
            if (result.success) {
                // 如果删除成功但有警告
                if (result.warning) {
                    showToast('警告', result.message, 'warning');
                } else {
                    showToast('成功', '存档已删除', 'success');
                }
                
                // 从列表移除
                currentSaves = currentSaves.filter(save => save.tag !== tagName);
                renderSavesList(currentSaves);
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '删除存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('删除存档失败:', error);
            showToast('错误', `删除存档失败: ${error.message}`, 'error');
        }
    }

    // 创建存档
    async function createSave(name, description) {
        try {
            // 修改：如果存檔名稱為空或只有空格，則自動生成香港時間的存檔名稱
            if (!name || name.trim() === '') {
                // 強制轉換為 Asia/Hong Kong 時區
                const hkNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Hong Kong" }));
                
                const yyyy = hkNow.getFullYear();
                // padStart 確保月份、日期、小時、分鐘永遠是兩位數
                const mm = String(hkNow.getMonth() + 1).padStart(2, '0'); 
                const dd = String(hkNow.getDate()).padStart(2, '0');
                const hh = String(hkNow.getHours()).padStart(2, '0');
                const min = String(hkNow.getMinutes()).padStart(2, '0');
                
                // 組合成 YYYY-MM-DD - HHMM
                name = `${yyyy}-${mm}-${dd} - ${hh}${min}`;
            }
            
            showLoading('正在创建存档...');
            
            const result = await apiCall('saves', 'POST', {
                name: name,
                description: description
            });
            
            if (result.success) {
                showToast('成功', '存档创建成功', 'success');
                
                // 清空输入
                saveNameInput.value = '';
                saveDescriptionInput.value = '';
                
                // 刷新列表
                await loadSavesList();
                await refreshStatus();
            } else {
                throw new Error(result.message || '创建存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('创建存档失败:', error);
            showToast('错误', `创建存档失败: ${error.message}`, 'error');
        }
    }

    // 重命名存档
    async function renameSave(oldTagName, newName, description) {
        try {
            if (!newName || newName.trim() === '') {
                showToast('错误', '存档名称不能为空', 'error');
                return;
            }
            
            showLoading('正在重命名存档...');
            
            const result = await apiCall(`saves/${oldTagName}`, 'PUT', {
                newName: newName,
                description: description
            });
            
            if (result.success) {
                showToast('成功', '存档重命名成功', 'success');
                
                // 刷新列表
                await loadSavesList();
            } else {
                throw new Error(result.message || '重命名存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('重命名存档失败:', error);
            showToast('错误', `重命名存档失败: ${error.message}`, 'error');
        }
    }

    // --- 授权函数 (MODIFIED - 移除内部 token 检查) ---
    async function authorize(repoUrl, displayName, branch) { // 移除 token 参数
        try {
            // URL 检查还是需要的，可以在调用前做，或者保留在这里
            if (!repoUrl) {
                 showToast('错误', '仓库 URL 不能为空', 'error');
                 return;
            }

            showLoading('正在授权并连接仓库...');

            // 注意：/authorize 接口不需要传递 token，它会从后端配置读取
            const result = await apiCall('authorize', 'POST', {
                branch: branch // 只传递分支信息
            });

            if (result.success) {
                isAuthorized = true;
                updateAuthUI(true); // 会根据 initialConfigHasToken 设置 placeholder
                await refreshStatus();
                await loadSavesList();
                showToast('成功', '仓库授权成功！', 'success');
            } else {
                throw new Error(result.message || '授权失败');
            }

            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('授权失败:', error);

            authStatus.innerHTML = `<i class="bi bi-x-circle-fill text-danger me-2"></i>授权失败: ${error.message}`;
            authStatus.classList.remove('alert-success');
            authStatus.classList.add('alert-danger');
            authStatus.style.display = 'block';

            showToast('错误', `授权失败: ${error.message}`, 'error');
        }
    }

    // 登出/断开连接 (MODIFIED - Explicitly reset flag)
    async function logout() {
        try {
            showLoading('正在断开连接...');

            // Send is_authorized: false to backend. Backend POST /config doesn't need other fields.
            await apiCall('config', 'POST', {
                github_token: '', // Send empty, backend ignores if no new token needed
                is_authorized: false // 核心是这个
            });

            isAuthorized = false;
            initialConfigHasToken = false; // Explicitly reset the flag on logout
            updateAuthUI(false); // Update UI (which will now correctly set placeholder to default based on the reset flag)
            // githubTokenInput.value = ''; // updateAuthUI handles this via the !initialConfigHasToken check

            hideLoading();
            showToast('成功', '已断开与仓库的连接', 'success');
        } catch (error) {
            hideLoading();
            console.error('断开连接失败:', error);
            showToast('错误', `断开连接失败: ${error.message}`, 'error');
        }
    }

    // 应用临时stash
    async function applyStash() {
        try {
            showLoading('正在恢复临时更改...');
            
            const result = await apiCall('stash/apply', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已恢复', 'success');
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '恢复临时更改失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('恢复临时更改失败:', error);
            showToast('错误', `恢复临时更改失败: ${error.message}`, 'error');
        }
    }

    // 丢弃临时stash
    async function discardStash() {
        try {
            showLoading('正在丢弃临时更改...');
            
            const result = await apiCall('stash/discard', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已丢弃', 'success');
                
                // 刷新状态
                await refreshStatus();
            } else {
                throw new Error(result.message || '丢弃临时更改失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('丢弃临时更改失败:', error);
            showToast('错误', `丢弃临时更改失败: ${error.message}`, 'error');
        }
    }

    // 覆盖存档
    async function overwriteSave(tagName) {
        try {
            showLoading('正在覆盖存档...');
            
            const result = await apiCall(`saves/${tagName}/overwrite`, 'POST');
            
            if (result.success) {
                showToast('成功', '存档已成功覆盖', 'success');
                // 覆盖后通常需要刷新列表，因为时间戳等信息可能更新 (取决于后端实现)
                await loadSavesList(); 
                await refreshStatus();
            } else {
                throw new Error(result.message || '覆盖存档失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('覆盖存档失败:', error);
            showToast('错误', `覆盖存档失败: ${error.message}`, 'error');
        }
    }

    // 过滤和排序存档列表
    function filterAndSortSaves() {
        if (!currentSaves || currentSaves.length === 0) return;
        
        const searchTerm = searchBox.value.toLowerCase();
        const sortMethod = sortSelector.value;
        
        // 筛选
        let filteredSaves = currentSaves;
        if (searchTerm) {
            filteredSaves = currentSaves.filter(save => 
                save.name.toLowerCase().includes(searchTerm) || 
                (save.description && save.description.toLowerCase().includes(searchTerm))
            );
        }
        
        // 排序
        filteredSaves.sort((a, b) => {
            switch (sortMethod) {
                case 'updated-desc': // 使用新的值
                    return new Date(b.updatedAt) - new Date(a.updatedAt);
                case 'updated-asc': // 使用新的值
                    return new Date(a.updatedAt) - new Date(b.updatedAt);
                case 'name-asc':
                    return a.name.localeCompare(b.name);
                case 'name-desc':
                    return b.name.localeCompare(a.name);
                default:
                    return 0;
            }
        });
        
        renderSavesList(filteredSaves);
    }

    // 保存配置函数
    async function saveConfiguration() {
        const repoUrl = repoUrlInput.value.trim();
        const token = githubTokenInput.value.trim();
        const displayName = displayNameInput.value.trim();
        const branch = branchInput.value.trim() || 'main';

        try {
            showLoading('正在保存配置...');
            const result = await apiCall('config', 'POST', {
                repo_url: repoUrl,
                github_token: token, // 发送实际输入值 (可能是空)
                display_name: displayName,
                branch: branch
                // 注意：这里不发送 is_authorized, autoSave* 等字段，避免意外修改
            });

            if (result.success) {
                showToast('成功', '配置已保存', 'success');
                branchInput.value = branch; // 更新UI上的分支名

                // --- 更新前端 token 状态 ---
                if (token) { // 如果用户输入了新的 token 并保存成功
                    initialConfigHasToken = true;
                    githubTokenInput.placeholder = "访问令牌已保存"; // 更新placeholder
                    githubTokenInput.value = ""; // 清空输入框的值
                } else if (!token && !initialConfigHasToken) {
                    // 如果用户没输入 token，且原本就没有 token，保持原样
                    githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                    githubTokenInput.value = "";
                } else if (!token && initialConfigHasToken) {
                    // 如果用户没输入 token，但原本有 token，恢复 placeholder
                    githubTokenInput.placeholder = "访问令牌已保存";
                    githubTokenInput.value = "";
                }

                // --- 结束更新前端 token 状态 ---

                hideLoading();
                return true;
            } else {
                throw new Error(result.message || '保存配置失败');
            }
        } catch (error) {
            hideLoading();
            console.error('保存配置失败:', error);
            showToast('错误', `保存配置失败: ${error.message}`, 'error');
            return false;
        }
    }

    // --- 修改：保存定时存档设置函数 (不再直接控制定时器) ---
    async function saveAutoSaveConfiguration() {
        const enabled = autoSaveEnabledSwitch.checked;
        const interval = parseInt(autoSaveIntervalInput.value, 10) || 30;
        const targetTag = autoSaveTargetTagInput.value.trim();

        if (enabled && !targetTag) {
            showToast('警告', '启用定时存档时，必须指定一个要覆盖的目标存档标签。', 'warning');
            return false;
        }

        try {
            showLoading('正在保存定时存档设置...');
            // 调用 /config 接口保存所有配置 (后端会根据新配置重启定时器)
            const result = await apiCall('config', 'POST', {
                repo_url: repoUrlInput.value.trim(),
                github_token: githubTokenInput.value.trim(), // 注意：这里如果为空或******，可能导致token被清空
                display_name: displayNameInput.value.trim(),
                branch: branchInput.value.trim() || 'main',
                autoSaveEnabled: enabled,
                autoSaveInterval: interval,
                autoSaveTargetTag: targetTag
            });

            if (result.success) {
                showToast('成功', '定时存档设置已保存 (后端将应用更改)', 'success');
                hideLoading();
                return true;
            } else {
                throw new Error(result.message || '保存定时设置失败');
            }
        } catch (error) {
            hideLoading();
            console.error('保存定时设置失败:', error);
            showToast('错误', `保存定时设置失败: ${error.message}`, 'error');
            return false;
        }
    }

    // 显示确认对话框 ... (保持不变) ...
    function showConfirmDialog(title, message, callback, confirmButtonType = 'danger') { 
        const titleElement = document.getElementById('confirmModalLabel');
        const messageElement = document.getElementById('confirm-message'); // 直接获取元素

        if (titleElement) {
             titleElement.textContent = title;
        } else {
            console.error('[Cloud Saves UI] Confirm dialog title element (confirmModalLabel) not found!');
        }

        if (messageElement) {
            messageElement.innerHTML = message; // 设置消息
        } else {
            console.error('[Cloud Saves UI] Confirm dialog message element (confirm-message) not found!');
        }
        
        confirmCallback = callback;
        
        // 确认按钮样式设置 (假设 confirmActionBtn 能正确获取)
        confirmActionBtn.classList.remove('btn-danger', 'btn-primary', 'btn-success', 'btn-warning', 'btn-secondary'); 
        if (confirmButtonType === 'danger') {
            confirmActionBtn.classList.add('btn-danger');
        } else if (confirmButtonType === 'primary') {
            confirmActionBtn.classList.add('btn-primary');
        } else {
            confirmActionBtn.classList.add('btn-secondary'); 
        }
        
        // 确保 confirmModal 实例存在
        if (confirmModal && typeof confirmModal.show === 'function') {
             confirmModal.show();
        } else {
             console.error('[Cloud Saves UI] Confirm dialog modal instance (confirmModal) is invalid or missing!');
             showToast('错误', '无法显示确认对话框', 'error'); // 给用户一个反馈
        }
    }

    // 绑定事件
    // --- 使用辅助函数安全地添加监听器 ---
    function safeAddEventListener(element, event, handler, elementIdForLogging) {
        if (element) {
            element.addEventListener(event, handler);
        } else {
            console.error(`[Cloud Saves UI] Element not found for ID: ${elementIdForLogging}. Cannot add event listener.`);
        }
    }

    // --- 事件监听器绑定 --- (MODIFIED - 调用 authorize 时不再传 token)
    safeAddEventListener(initRepoBtn, 'click', () => {
        showConfirmDialog(
            '确认强制初始化仓库',
            '<strong>警告：此操作将删除 data 目录下的现有 Git 历史 (如果存在)！</strong><br>确定要强制初始化本地 Git 仓库并配置远程地址吗？',
            initializeRepository,
            'danger' // 危险操作用红色按钮
        );
    }, 'init-repo-btn');
    safeAddEventListener(configureBtn, 'click', saveConfiguration, 'configure-btn');
    safeAddEventListener(authorizeBtn, 'click', async () => {
        const repoUrl = repoUrlInput.value.trim();
        const tokenInputValue = githubTokenInput.value.trim(); // 读取当前输入框的值
        const displayName = displayNameInput.value.trim();
        const branch = branchInput.value.trim() || 'main';

        if (!repoUrl) {
            showToast('错误', '仓库 URL 不能为空', 'error');
            return;
        }
        // 检查1: 如果用户 *输入了新* token
        if (tokenInputValue && tokenInputValue !== "") {
            showToast('提示', '检测到新的访问令牌输入，请先点击"配置"按钮保存新令牌，然后再点击"授权并连接"。', 'info');
            return; // 阻止直接授权
        }
        // 检查2: 如果用户 *没输入新* token，且 *后台原本就没* token
        if (!tokenInputValue && !initialConfigHasToken) {
            showToast('错误', 'GitHub 访问令牌不能为空，请在上方输入或点击"配置"保存。', 'error');
            return;
        }

        // 如果执行到这里，说明：
        // - URL 已输入
        // - 要么输入框为空且后台有 token (initialConfigHasToken is true) -> 使用后台 token
        // (已经排除了"输入框为空且后台没token" 和 "输入框有新token" 的情况)

        // 执行授权 (不再传递 tokenInputValue)
        await authorize(repoUrl, displayName, branch);

    }, 'authorize-btn');
    safeAddEventListener(logoutBtn, 'click', () => {
        showConfirmDialog('确认断开连接', '您确定要断开与仓库的连接吗？这将不会删除任何数据。', logout, 'primary');
    }, 'logout-btn');
    safeAddEventListener(createSaveBtn, 'click', () => {
        createSave(saveNameInput.value, saveDescriptionInput.value);
    }, 'create-save-btn');
    safeAddEventListener(confirmRenameBtn, 'click', () => {
        renameSave(renameTagNameInput.value, renameNewNameInput.value, renameDescriptionInput.value);
        renameModal.hide();
    }, 'confirm-rename-btn');
    safeAddEventListener(confirmActionBtn, 'click', () => {
        if (typeof confirmCallback === 'function') {
            confirmCallback();
        }
        confirmModal.hide();
    }, 'confirm-action-btn');
    safeAddEventListener(refreshSavesBtn, 'click', loadSavesList, 'refresh-saves-btn');
    safeAddEventListener(searchBox, 'input', filterAndSortSaves, 'search-box');
    safeAddEventListener(sortSelector, 'change', filterAndSortSaves, 'sort-selector');
    safeAddEventListener(applyStashBtn, 'click', applyStash, 'apply-stash-btn');
    safeAddEventListener(discardStashBtn, 'click', () => {
        showConfirmDialog('确认丢弃临时更改', '您确定要丢弃所有临时保存的更改吗？此操作无法撤销。', discardStash, 'danger');
    }, 'discard-stash-btn');
    safeAddEventListener(autoSaveEnabledSwitch, 'change', () => {
        autoSaveOptionsDiv.style.display = autoSaveEnabledSwitch.checked ? 'flex' : 'none';
    }, 'auto-save-enabled');
    safeAddEventListener(saveAutoSaveSettingsBtn, 'click', saveAutoSaveConfiguration, 'save-auto-save-settings-btn');

    // 新增：检查更新按钮事件
    safeAddEventListener(checkUpdateBtn, 'click', checkAndApplyUpdate, 'check-update-btn');

    // --- 新增：初始化仓库函数 ---
    async function initializeRepository() {
        try {
            showLoading('正在初始化仓库...');
            const result = await apiCall('initialize', 'POST');
            
            if (result.success) {
                let message = result.message || '仓库初始化成功';
                if (result.warning) {
                    // 显示警告，并提示重新授权
                    showToast('警告', message, 'warning');
                    showToast('提示', '初始化完成，请点击 **授权并连接** 按钮以验证并同步远程仓库。', 'info'); // 添加提示
                } else {
                    // 显示成功，并提示重新授权
                    showToast('成功', message, 'success');
                    showToast('提示', '初始化完成，请点击 **授权并连接** 按钮以验证并同步远程仓库。', 'info'); // 添加提示
                }
                // 初始化后刷新状态 (可能显示未授权)
                await refreshStatus();
            } else {
                throw new Error(result.message || '初始化仓库失败');
            }
            
            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('初始化仓库失败:', error);
            showToast('错误', `初始化仓库失败: ${error.message}`, 'error');
        }
    }

    // --- 新增：检查更新函数 ---
    async function checkAndApplyUpdate() {
        try {
            showLoading('正在检查插件更新...');
            const result = await apiCall('update/check-and-pull', 'POST');

            if (result.success) {
                let message = result.message || '操作完成';
                let type = 'info';
                if (result.status === 'latest') {
                    type = 'success';
                    message = '插件已是最新版本。'
                } else if (result.status === 'updated') {
                    type = 'success';
                    message = '插件更新成功！请务必重启 SillyTavern 服务以应用更改。';
                } else if (result.status === 'not_git_repo') {
                    type = 'warning';
                    message = '无法自动更新：插件似乎不是通过 Git 安装的。'
                }
                showToast('检查更新', message, type);
            } else {
                // 如果 success 为 false，也显示消息
                 showToast('更新失败', result.message || '检查或应用更新时发生未知错误。', 'error');
            }

            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('检查更新失败:', error);
            showToast('错误', `检查更新时发生错误: ${error.message}`, 'error');
        }
    }

    // --- 绑定事件 --- (MODIFIED for githubTokenInput focus/blur)
    safeAddEventListener(githubTokenInput, 'focus', () => {
        if (githubTokenInput.placeholder === "访问令牌已保存") {
            githubTokenInput.placeholder = "输入新令牌以覆盖..."; // 提供更清晰的提示
        }
    }, 'github-token-focus');

    safeAddEventListener(githubTokenInput, 'blur', () => {
        // 当输入框失去焦点时
        if (githubTokenInput.value === "" && initialConfigHasToken) {
            // 如果输入框是空的，并且我们知道后台本来是有token的
            githubTokenInput.placeholder = "访问令牌已保存"; // 恢复提示
        } else if (githubTokenInput.value === "" && !initialConfigHasToken) {
             // 如果输入框是空的，且后台本来就没token
             githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx"; // 恢复默认提示
        }
        // 如果用户输入了内容，placeholder 不会被显示，所以不需要处理这种情况
    }, 'github-token-blur');

    // 初始化
    init();

}); // DOMContentLoaded 结束 
