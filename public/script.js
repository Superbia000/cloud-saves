/**
 * ============================================================================
 * SillyTavern Cloud Saves 插件 - 前端逻辑脚本 (script.js)
 * ============================================================================
 * 
 * 功能概述：
 *   本脚本负责云存档插件前端的所有交互逻辑，包括：
 *     - 仓库授权与配置管理
 *     - 存档的创建、加载、删除、重命名、覆盖
 *     - 存档列表的搜索、排序和渲染
 *     - 存档差异对比
 *     - 定时自动存档设置
 *     - 临时 Stash 的管理（应用/丢弃）
 *     - 插件更新检查
 *     - Toast 通知、加载遮罩、确认对话框等 UI 组件
 * 
 * 架构设计：
 *   - 所有操作通过 apiCall() 统一函数调用后端 API
 *   - DOM 操作集中在特定函数中，便于维护
 *   - 使用 Bootstrap 5 的 Modal、Toast 等组件
 *   - 全局状态通过变量管理（isAuthorized, currentSaves 等）
 * 
 * 安全机制：
 *   - 所有非 GET 请求自动获取 CSRF Token 并添加到请求头
 *   - GitHub Token 在前端只显示占位符，不暴露实际值
 * 
 * 依赖：
 *   - Bootstrap 5 JS（模态框、Toast）
 *   - Bootstrap Icons（图标）
 *   - 后端 API 端点（/api/plugins/cloud-saves/*）
 * 
 * ============================================================================
 */

// DOMContentLoaded 事件：确保页面完全加载后再执行脚本
document.addEventListener('DOMContentLoaded', function() {
    
    // =========================== 全局状态变量 ===========================
    
    /** @type {boolean} isAuthorized - 当前是否已完成仓库授权 */
    let isAuthorized = false;
    
    /** @type {Array<object>} currentSaves - 当前显示的存档列表数据 */
    let currentSaves = [];
    
    /** @type {Function|null} confirmCallback - 确认对话框的确认回调函数 */
    let confirmCallback = null;
    
    /** @type {string|null} renameTarget - 当前要重命名的存档标签名 */
    let renameTarget = null;
    
    /** @type {boolean} initialConfigHasToken - 初始配置是否包含 token（影响输入框占位符显示） */
    let initialConfigHasToken = false;

    // =========================== DOM 元素引用缓存 ===========================
    // 缓存所有需要频繁访问的 DOM 元素引用，减少 document.getElementById 调用

    // --- 授权区域 ---
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
    const initRepoBtn = document.getElementById('init-repo-btn');

    // --- 创建存档区域 ---
    const createSaveSection = document.getElementById('create-save-section');
    const saveNameInput = document.getElementById('save-name');
    const saveDescriptionInput = document.getElementById('save-description');
    const createSaveBtn = document.getElementById('create-save-btn');

    // --- 存档列表区域 ---
    const savesSection = document.getElementById('saves-section');
    const savesContainer = document.getElementById('saves-container');
    const noSavesMessage = document.getElementById('no-saves-message');
    const refreshSavesBtn = document.getElementById('refresh-saves-btn');
    const searchBox = document.getElementById('search-box');
    const sortSelector = document.getElementById('sort-selector');

    // --- Stash 通知区域 ---
    const stashNotification = document.getElementById('stash-notification');
    const applyStashBtn = document.getElementById('apply-stash-btn');
    const discardStashBtn = document.getElementById('discard-stash-btn');

    // --- 状态栏 ---
    const gitStatus = document.getElementById('git-status');
    const changesStatus = document.getElementById('changes-status');
    const changesCount = document.getElementById('changes-count');
    const currentSaveStatus = document.getElementById('current-save-status');

    // --- 加载遮罩 ---
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingMessage = document.getElementById('loading-message');

    // --- 重命名模态框 ---
    const renameModal = new bootstrap.Modal(document.getElementById('renameModal'));
    const renameTagNameInput = document.getElementById('rename-tag-name');
    const renameNewNameInput = document.getElementById('rename-new-name');
    const renameDescriptionInput = document.getElementById('rename-description');
    const confirmRenameBtn = document.getElementById('confirm-rename-btn');

    // --- 确认对话框模态框 ---
    const confirmModal = new bootstrap.Modal(document.getElementById('confirmModal'));
    const confirmMessageText = document.getElementById('confirm-message');
    const confirmActionBtn = document.getElementById('confirm-action-btn');

    // --- 差异对比模态框 ---
    const diffModal = new bootstrap.Modal(document.getElementById('diffModal'));
    const diffSummary = document.getElementById('diff-summary');
    const diffFiles = document.getElementById('diff-files');

    // --- 定时存档 UI 元素 ---
    const autoSaveSection = document.getElementById('auto-save-section');
    const autoSaveEnabledSwitch = document.getElementById('auto-save-enabled');
    const autoSaveOptionsDiv = document.getElementById('auto-save-options');
    const autoSaveIntervalInput = document.getElementById('auto-save-interval');
    const autoSaveTargetTagInput = document.getElementById('auto-save-target-tag');
    const saveAutoSaveSettingsBtn = document.getElementById('save-auto-save-settings-btn');

    // --- 自动存档模式切换元素 ---
    const autoSaveModeOverwriteRadio = document.getElementById('auto-save-mode-overwrite');
    const autoSaveModeCreateRadio = document.getElementById('auto-save-mode-create');
    const autoSaveModeHint = document.getElementById('auto-save-mode-hint');
    const autoSaveTargetTagRow = document.getElementById('auto-save-target-tag-row');

    // --- 检查更新按钮 ---
    const checkUpdateBtn = document.getElementById('check-update-btn');

    // =========================== API 调用工具函数 ===========================

    /**
     * apiCall - 统一的 API 调用封装函数
     * 
     * 封装了所有与后端通信的细节，包括：
     *   - CSRF Token 的自动获取和注入
     *   - JSON 请求/响应的序列化/反序列化
     *   - HTTP 错误的统一处理
     *   - 非 JSON 响应的检测（如认证错误返回 HTML）
     * 
     * CSRF 保护机制：
     *   SillyTavern 使用 CSRF Token 来防止跨站请求伪造攻击。
     *   所有非 GET 请求都必须携带有效的 CSRF Token。
     *   获取方式：先请求 /csrf-token 端点获取 token，
     *   然后将其添加到请求头的 X-CSRF-Token 字段中。
     * 
     * @param {string} endpoint - API 端点路径（不包含基础 URL）
     * @param {string} method - HTTP 方法 (GET|POST|PUT|DELETE)，默认为 'GET'
     * @param {object|null} data - 要发送的请求体数据（仅用于 POST/PUT）
     * @returns {Promise<object>} - 解析后的 JSON 响应
     * @throws {Error} - 当请求失败或返回错误时抛出
     */
    async function apiCall(endpoint, method = 'GET', data = null) {
        const options = {
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        // 对于非 GET/HEAD 请求，获取 CSRF Token 并添加到请求头
        if (method !== 'GET' && method !== 'HEAD') {
            try {
                // 向 SillyTavern 主程序请求 CSRF Token
                const csrfResponse = await fetch('/csrf-token');
                if (!csrfResponse.ok) {
                    throw new Error(`获取CSRF令牌失败: ${csrfResponse.statusText}`);
                }
                const csrfData = await csrfResponse.json();
                if (!csrfData || !csrfData.token) {
                    throw new Error('无效的CSRF令牌响应');
                }
                // 将 token 添加到请求头
                options.headers['X-CSRF-Token'] = csrfData.token;
            } catch (csrfError) {
                console.error('无法获取或设置CSRF令牌:', csrfError);
                showToast('错误', `无法执行操作，获取安全令牌失败: ${csrfError.message}`, 'error');
                throw csrfError;
            }
        }

        // 将 data 对象序列化为 JSON 字符串作为请求体
        if (data && (method === 'POST' || method === 'PUT')) {
            options.body = JSON.stringify(data);
        }

        try {
            // 发送请求（基础路径 /api/plugins/cloud-saves/ 由 SillyTavern 路由提供）
            const response = await fetch(`/api/plugins/cloud-saves/${endpoint}`, options);
            
            // 检测非 JSON 响应（通常是认证错误或服务器错误返回的 HTML 页面）
            if (!response.ok && response.headers.get('content-type')?.includes('text/html')) {
                if (response.status === 403) {
                    throw new Error('认证或权限错误 (403 Forbidden)。可能是CSRF令牌问题或GitHub Token权限不足。');
                } else {
                    throw new Error(`请求失败，服务器返回了非JSON响应 (状态码: ${response.status})`);
                }
            }
            
            // 解析 JSON 响应
            const result = await response.json();
            
            // HTTP 状态码非 2xx 时视为错误
            if (!response.ok) {
                throw new Error(result.message || `请求失败，状态码: ${response.status}`); 
            }
            
            return result;
        } catch (error) {
            console.error(`API调用失败 (${endpoint}):`, error);
            // 避免重复显示 CSRF 错误
            if (!error.message.includes('安全令牌失败')) {
                showToast('错误', `操作失败: ${error.message}`, 'error');
            }
            throw error;
        }
    }

    // =========================== UI 工具函数 ===========================

    /**
     * showLoading - 显示加载遮罩层
     * 
     * 在耗时操作期间覆盖整个界面，防止用户误操作，
     * 同时提供加载状态的可视化反馈。
     * 
     * @param {string} message - 加载提示文字，默认为 "正在加载..."
     */
    function showLoading(message = '正在加载...') {
        loadingMessage.textContent = message;
        loadingOverlay.style.display = 'flex';  // 使用 flex 居中加载动画
    }

    /**
     * hideLoading - 隐藏加载遮罩层
     */
    function hideLoading() {
        loadingOverlay.style.display = 'none';
    }

    /**
     * showToast - 显示 Toast 通知消息
     * 
     * Toast 是轻量级的非阻塞通知，自动在数秒后消失。
     * 位于页面右上角，不同类型的通知有不同的左边框颜色：
     *   - success: 绿色边框
     *   - error/danger: 红色边框
     *   - warning: 黄色边框
     *   - info: 主色边框
     * 
     * 工作原理：
     *   动态创建 DOM 元素，添加到 toast-container 中，
     *   5 秒后自动淡出并移除。
     * 
     * @param {string} title - 通知标题
     * @param {string} message - 通知内容
     * @param {string} type - 通知类型 (success|error|danger|warning|info)
     */
    function showToast(title, message, type = 'info') {
        const toastContainer = document.querySelector('.toast-container');
        
        // 创建 toast 元素
        const toast = document.createElement('div');
        toast.classList.add('toast', 'show');
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');
        
        // 根据类型设置不同的左边框颜色
        if (type === 'success') {
            toast.style.borderLeft = '4px solid var(--bs-success)';
        } else if (type === 'error' || type === 'danger') {
            toast.style.borderLeft = '4px solid var(--bs-danger)';
        } else if (type === 'warning') {
            toast.style.borderLeft = '4px solid var(--bs-warning)';
        } else {
            toast.style.borderLeft = '4px solid var(--bs-primary)';
        }
        
        // 设置 toast 内部 HTML 结构
        toast.innerHTML = `
            <div class="toast-header">
                <strong class="me-auto">${title}</strong>
                <button type="button" class="btn-close btn-close-white" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
            <div class="toast-body">${message}</div>
        `;
        
        toastContainer.appendChild(toast);
        
        // 5 秒后自动移除
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);  // 等待淡出动画完成（300ms）
        }, 5000);
        
        // 关闭按钮点击事件
        toast.querySelector('.btn-close').addEventListener('click', () => {
            toast.classList.remove('show');
            setTimeout(() => {
                toast.remove();
            }, 300);
        });
    }

    // =========================== 初始化函数 ===========================

    /**
     * init - 页面初始化函数
     * 
     * 页面加载后立即执行，完成以下任务：
     *   1. 从后端读取当前配置
     *   2. 用配置填充表单字段
     *   3. 处理 Token 输入框的占位符显示
     *   4. 设置自动存档相关的 UI 状态
     *   5. 如果已授权，刷新状态并加载存档列表
     * 
     * 错误处理：
     *   如果读取配置失败（如后端未启动），设置默认占位符状态
     */
    async function init() {
        try {
            const config = await apiCall('config');

            // 填充表单字段
            if (config.repo_url) repoUrlInput.value = config.repo_url;
            if (config.display_name) displayNameInput.value = config.display_name;
            if (config.branch) branchInput.value = config.branch;
            
            // Token 输入框处理逻辑：
            // 如果后端已保存 token，显示"已保存"占位符，不显示实际值
            initialConfigHasToken = config.has_github_token;
            if (initialConfigHasToken) {
                githubTokenInput.placeholder = "访问令牌已保存";
                githubTokenInput.value = "";
            } else {
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                githubTokenInput.value = "";
            }
            
            // 设置自动存档开关和选项
            autoSaveEnabledSwitch.checked = config.autoSaveEnabled || false;
            autoSaveIntervalInput.value = config.autoSaveInterval || 30;
            autoSaveTargetTagInput.value = config.autoSaveTargetTag || '';

            // 设置自动存档模式（覆盖 vs 创建）
            const savedMode = config.autoSaveMode || 'overwrite';
            if (savedMode === 'create') {
                autoSaveModeCreateRadio.checked = true;
                autoSaveModeOverwriteRadio.checked = false;
                autoSaveTargetTagRow.style.display = 'none';      // 创建模式不需要目标标签
                autoSaveModeHint.textContent = '创建模式：每次自动存档将创建新存档（命名格式：YYYY-MM-DD - HHMM (Auto Save)），使用浏览器时区。';
            } else {
                autoSaveModeOverwriteRadio.checked = true;
                autoSaveModeCreateRadio.checked = false;
                autoSaveTargetTagRow.style.display = '';           // 覆盖模式需要目标标签
                autoSaveModeHint.textContent = '覆盖模式：每次自动存档将覆盖指定的已有存档标签。';
            }

            // 根据启用状态显示/隐藏自动存档选项
            autoSaveOptionsDiv.style.display = autoSaveEnabledSwitch.checked ? 'flex' : 'none';
            
            isAuthorized = config.is_authorized;
            
            // 更新 UI 以反映授权状态
            updateAuthUI(isAuthorized);
            
            // 如果已授权，加载完整数据
            if (isAuthorized) {
                await refreshStatus();
                await loadSavesList();
            }
        } catch (error) {
            // 初始化失败时设置默认状态
            githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
            githubTokenInput.value = "";
            initialConfigHasToken = false;
        }
    }

    // =========================== UI 状态更新函数 ===========================

    /**
     * updateAuthUI - 根据授权状态更新 UI 显示
     * 
     * 授权成功时：
     *   - 显示成功提示
     *   - 显示断开连接按钮
     *   - 显示创建存档、存档列表、自动存档区域
     * 
     * 未授权时：
     *   - 隐藏上述所有区域
     *   - 重置 Token 输入框占位符
     * 
     * @param {boolean} authorized - 是否已授权
     */
    function updateAuthUI(authorized) {
        isAuthorized = authorized;

        if (authorized) {
            authStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>已成功授权`;
            authStatus.classList.remove('alert-danger');
            authStatus.classList.add('alert-success');
            authStatus.style.display = 'block';
            logoutBtn.style.display = 'inline-block';
            createSaveSection.style.display = 'block';
            savesSection.style.display = 'block';
            autoSaveSection.style.display = 'block';

            if (initialConfigHasToken) {
                githubTokenInput.placeholder = "访问令牌已保存";
                githubTokenInput.value = "";
            } else {
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                githubTokenInput.value = "";
            }
        } else {
            authStatus.style.display = 'none';
            logoutBtn.style.display = 'none';
            createSaveSection.style.display = 'none';
            savesSection.style.display = 'none';
            autoSaveSection.style.display = 'none';

            if (initialConfigHasToken) {
                githubTokenInput.placeholder = "访问令牌已保存";
                githubTokenInput.value = "";
            } else {
                githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                githubTokenInput.value = "";
            }
        }
    }

    /**
     * refreshStatus - 刷新 Git 仓库状态并更新状态栏
     * 
     * 从后端获取当前仓库状态，更新：
     *   - Git 仓库是否就绪
     *   - 未保存更改数量
     *   - 当前加载的存档名称
     *   - 临时 Stash 通知条的显示/隐藏
     */
    async function refreshStatus() {
        try {
            const statusResult = await apiCall('status');
            
            if (statusResult.success && statusResult.status) {
                const status = statusResult.status;
                
                // 更新 Git 仓库状态指示器
                if (status.initialized) {
                    gitStatus.innerHTML = `<i class="bi bi-check-circle-fill text-success me-2"></i>Git仓库就绪`;
                } else {
                    gitStatus.innerHTML = `<i class="bi bi-circle-fill text-secondary me-2"></i>Git仓库未初始化`;
                }
                
                // 更新未保存更改数量
                if (status.changes && status.changes.length > 0) {
                    changesCount.textContent = status.changes.length;
                    changesStatus.style.display = 'inline';
                } else {
                    changesStatus.style.display = 'none';
                }
                
                // 更新当前存档信息
                if (status.currentSave) {
                    // 从标签名中提取存档名称（解码 base64url）
                    const saveNameMatch = status.currentSave.tag.match(/^save_\d+_(.+)$/);
                    const saveName = saveNameMatch ? saveNameMatch[1] : status.currentSave.tag;
                    currentSaveStatus.innerHTML = `当前存档: <strong>${saveName}</strong>`;
                } else {
                    currentSaveStatus.textContent = '未加载任何存档';
                }
                
                // 显示/隐藏 Stash 通知条
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

    // =========================== 存档列表加载与渲染 ===========================

    /**
     * loadSavesList - 从后端加载存档列表并渲染到页面
     * 
     * 流程：
     *   1. 显示加载遮罩
     *   2. 调用 API 获取存档列表
     *   3. 更新 currentSaves 全局状态
     *   4. 调用 renderSavesList 渲染 HTML
     *   5. 隐藏加载遮罩
     */
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

    /**
     * renderSavesList - 将存档数据渲染为 HTML 卡片列表
     * 
     * 每个存档卡片包含：
     *   - 存档名称、创建时间、更新时间
     *   - 操作人信息
     *   - 描述文本
     *   - 标签名和复制按钮
     *   - 操作按钮组：重命名、加载、覆盖、差异、删除
     * 
     * 特殊标记：
     *   - 如果存档是当前加载的，右上角显示"当前存档"徽章
     * 
     * 渲染流程：
     *   1. 清空容器
     *   2. 检查是否为空（显示空状态占位）
     *   3. 异步获取当前加载的存档信息
     *   4. 遍历存档数据创建卡片 DOM
     *   5. 为当前存档添加角标
     *   6. 注册所有按钮的事件处理器
     * 
     * @param {Array<object>} saves - 存档对象数组
     */
    function renderSavesList(saves) {
        // 清空容器（保留 no-saves-message 用于空状态）
        while (savesContainer.firstChild) {
            savesContainer.removeChild(savesContainer.firstChild);
        }
        
        // 空列表：显示空状态提示
        if (saves.length === 0) {
            savesContainer.appendChild(noSavesMessage);
            return;
        }
        
        // 异步获取当前加载的存档标签名
        let currentLoadedSave = null;
        apiCall('config').then(config => {
            if (config.current_save && config.current_save.tag) {
                currentLoadedSave = config.current_save.tag;
                
                // 如果当前存档卡片已渲染，添加角标
                const currentSaveCard = document.querySelector(`.save-card[data-tag="${currentLoadedSave}"]`);
                if (currentSaveCard) {
                    const badge = document.createElement('div');
                    badge.classList.add('save-current-badge');
                    badge.textContent = '当前存档';
                    currentSaveCard.appendChild(badge);
                }
            }
        });
        
        // 遍历每个存档，创建对应的卡片 DOM
        saves.forEach(save => {
            // 创建卡片容器
            const saveCard = document.createElement('div');
            saveCard.classList.add('card', 'save-card', 'mb-3');
            saveCard.dataset.tag = save.tag;  // 将标签名存入 dataset 便于查找
            
            // 格式化时间戳为本地可读格式
            const createdAtDate = new Date(save.createdAt);
            const updatedAtDate = new Date(save.updatedAt);
            const formattedCreatedAt = createdAtDate.toLocaleString();
            const formattedUpdatedAt = updatedAtDate.toLocaleString();
            
            // 获取描述和创建者信息
            const descriptionText = save.description || '无描述';
            const creatorName = save.creator || '未知';
            
            // 构建卡片 HTML 结构
            saveCard.innerHTML = `
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start">
                        <!-- 左侧：存档信息 -->
                        <div style="flex-grow: 1; margin-right: 15px;">
                            <h5 class="card-title mb-1">${save.name}</h5>
                            <div class="save-timestamp mb-1">
                                <small>创建于: ${formattedCreatedAt} | 更新于: ${formattedUpdatedAt}</small>
                            </div>
                            <div class="save-creator mb-2">操作人: ${creatorName}</div>
                            <div class="save-description">${descriptionText}</div>
                            <!-- 标签名和复制按钮 -->
                            <div class="save-tag-info mt-2">
                                <small class="text-muted">标签名: <code class="user-select-all">${save.tag}</code></small>
                                <button class="btn btn-sm btn-outline-secondary copy-tag-btn ms-1" data-tag="${save.tag}" title="复制标签名">
                                    <i class="bi bi-clipboard"></i>
                                </button>
                            </div>
                        </div>
                        <!-- 右侧：操作按钮组 -->
                        <div class="action-buttons flex-shrink-0">
                            <!-- 重命名按钮 (bi-pencil) -->
                            <button class="btn btn-sm btn-primary rename-save-btn" data-tag="${save.tag}" 
                                    data-name="${save.name}" data-description="${descriptionText}" title="重命名此存档">
                                <i class="bi bi-pencil"></i>
                            </button>
                            <!-- 加载按钮 (bi-cloud-download) -->
                            <button class="btn btn-sm btn-success load-save-btn" data-tag="${save.tag}" title="加载此存档">
                                <i class="bi bi-cloud-download"></i>
                            </button>
                            <!-- 覆盖按钮 (bi-upload) -->
                            <button class="btn btn-sm btn-warning overwrite-save-btn" data-tag="${save.tag}" 
                                    data-name="${save.name}" title="用当前本地数据覆盖此云存档">
                                <i class="bi bi-upload"></i>
                            </button>
                            <!-- 差异对比按钮 (bi-file-diff) -->
                            <button class="btn btn-sm btn-outline-info diff-save-btn" data-tag="${save.tag}" 
                                    data-name="${save.name}" title="比较差异">
                                <i class="bi bi-file-diff"></i>
                            </button>
                            <!-- 删除按钮 (bi-trash) -->
                            <button class="btn btn-sm btn-danger delete-save-btn" data-tag="${save.tag}" title="删除此存档">
                                <i class="bi bi-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
            
            // 如果是当前加载的存档，立即添加角标
            if (save.tag === currentLoadedSave) {
                const badge = document.createElement('div');
                badge.classList.add('save-current-badge');
                badge.textContent = '当前存档';
                saveCard.appendChild(badge);
            }
            
            savesContainer.appendChild(saveCard);
        });
        
        // 注册所有按钮的事件处理器
        registerSaveCardEvents();
    }
    
    /**
     * registerSaveCardEvents - 为动态渲染的存档卡片按钮绑定事件
     * 
     * 由于存档卡片是动态创建的（而非在 HTML 中写死），
     * 需要使用事件委托或动态绑定方式来注册事件。
     * 这里采用 querySelectorAll + forEach 的方式为每个按钮单独绑定。
     * 
     * 注册的按钮类型：
     *   1. .load-save-btn         - 加载存档
     *   2. .rename-save-btn       - 打开重命名模态框
     *   3. .overwrite-save-btn    - 覆盖存档
     *   4. .delete-save-btn       - 删除存档
     *   5. .diff-save-btn         - 查看差异
     *   6. .copy-tag-btn          - 复制标签名到剪贴板
     */
    function registerSaveCardEvents() {
        
        // --- 加载存档按钮 ---
        document.querySelectorAll('.load-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                // 使用确认对话框，防止误操作
                showConfirmDialog(
                    `确认加载存档`,
                    `您确定要加载此存档吗？所有当前未保存的更改将被暂存。`,
                    async () => {
                        await loadSave(tagName);
                    }
                );
            });
        });
        
        // --- 重命名存档按钮 ---
        document.querySelectorAll('.rename-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                renameTarget = this.dataset.tag;          // 记录要重命名的标签
                renameTagNameInput.value = renameTarget;   // 填充隐藏字段
                renameNewNameInput.value = this.dataset.name || '';
                renameDescriptionInput.value = this.dataset.description || '';
                renameModal.show();                       // 显示重命名模态框
            });
        });
        
        // --- 覆盖存档按钮（危险操作，需要确认） ---
        document.querySelectorAll('.overwrite-save-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                const saveName = this.dataset.name || tagName;
                showConfirmDialog(
                    `确认覆盖存档 "${saveName}"`,
                    `<strong>警告：此操作不可逆！</strong><br>您确定要用当前本地的 SillyTavern 数据覆盖云端的 "${saveName}" 存档吗？云端该存档之前的内容将会丢失。`,
                    async () => {
                        await overwriteSave(tagName);
                    },
                    'danger'
                );
            });
        });
        
        // --- 删除存档按钮 ---
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
        
        // --- 差异对比按钮 ---
        document.querySelectorAll('.diff-save-btn').forEach(btn => {
            btn.addEventListener('click', async function() {
                const tagName = this.dataset.tag;
                const saveName = this.dataset.name;
                
                try {
                    showLoading('正在加载差异...');
                    
                    // 对比存档标签和当前 HEAD 之间的差异
                    const tagRef1 = encodeURIComponent(tagName);
                    const tagRef2 = 'HEAD';
                    const result = await apiCall(`saves/diff?tag1=${tagRef1}&tag2=${tagRef2}`);
                    
                    if (result.success) {
                        // 设置模态框标题
                        const diffModalLabel = document.getElementById('diffModalLabel');
                        diffModalLabel.textContent = `存档 "${saveName || tagName}" 与当前状态的差异`;
                        
                        diffSummary.innerHTML = ''; 
                        diffSummary.style.display = 'none'; 
                        
                        diffFiles.innerHTML = '';
                        if (result.changedFiles && result.changedFiles.length > 0) {
                            // 构建变更文件列表
                            const fileList = document.createElement('ul');
                            fileList.classList.add('list-unstyled'); 
                            result.changedFiles.forEach(file => {
                                const li = document.createElement('li');
                                li.classList.add('mb-1');
                                
                                // 根据变更状态设置图标和颜色
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
                            // 无变更
                            diffFiles.innerHTML = '<p class="text-center text-secondary mt-3">此存档与当前状态没有文件差异。</p>';
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

        // --- 复制标签名按钮 ---
        document.querySelectorAll('.copy-tag-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                const tagName = this.dataset.tag;
                // 使用 Clipboard API 复制文本
                navigator.clipboard.writeText(tagName).then(() => {
                    // 复制成功后图标短暂变为对勾
                    const icon = this.querySelector('i');
                    const originalIconClass = icon.className;
                    icon.className = 'bi bi-check-lg text-success'; 
                    showToast('提示', '标签名已复制到剪贴板', 'info');
                    // 1.5 秒后恢复原图标
                    setTimeout(() => {
                        icon.className = originalIconClass;
                    }, 1500);
                }).catch(err => {
                    console.error('复制标签名失败:', err);
                    showToast('错误', '复制标签名失败', 'error');
                });
            });
        });
    }

    // =========================== 存档操作函数 ===========================

    /**
     * loadSave - 加载指定的存档到当前工作区
     * 
     * 加载后会自动刷新状态，并为当前存档添加高亮角标。
     * 
     * @param {string} tagName - 要加载的存档标签名
     */
    async function loadSave(tagName) {
        try {
            showLoading('正在加载存档...');
            
            const result = await apiCall('saves/load', 'POST', { tagName });
            
            if (result.success) {
                showToast('成功', '存档加载成功', 'success');
                await refreshStatus();
                // 高亮当前加载的存档卡片
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

    /**
     * highlightCurrentSave - 高亮显示当前加载的存档
     * 
     * 移除所有旧的"当前存档"角标，然后在指定标签的卡片上添加新角标。
     * 
     * @param {string} tagName - 当前存档的标签名
     */
    function highlightCurrentSave(tagName) {
        // 移除所有已存在的角标
        document.querySelectorAll('.save-current-badge').forEach(badge => badge.remove());
        // 在对应卡片上添加角标
        const saveCard = document.querySelector(`.save-card[data-tag="${tagName}"]`);
        if (saveCard) {
            const badge = document.createElement('div');
            badge.classList.add('save-current-badge');
            badge.textContent = '当前存档';
            saveCard.appendChild(badge);
        }
    }

    /**
     * deleteSave - 删除指定的存档
     * 
     * 删除成功后从本地列表移除并重新渲染。
     * 如果删除的是远程存档但删除失败（网络问题），会显示警告。
     * 
     * @param {string} tagName - 要删除的存档标签名
     */
    async function deleteSave(tagName) {
        try {
            showLoading('正在删除存档...');
            
            const result = await apiCall(`saves/${tagName}`, 'DELETE');
            
            if (result.success) {
                if (result.warning) {
                    // 远程删除有问题但本地已删除
                    showToast('警告', result.message, 'warning');
                } else {
                    showToast('成功', '存档已删除', 'success');
                }
                
                // 从本地列表移除并重新渲染
                currentSaves = currentSaves.filter(save => save.tag !== tagName);
                renderSavesList(currentSaves);
                
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

    /**
     * createSave - 创建一个新的云端存档
     * 
     * 存档名称如果为空，自动生成格式：YYYY-MM-DD - HHMM
     * 创建成功后清空输入框并刷新列表。
     * 
     * @param {string} name - 存档名称
     * @param {string} description - 存档描述
     */
    async function createSave(name, description) {
        try {
            // 处理空名称：自动生成
            let finalName = name ? name.trim() : '';
            if (finalName === '') {
                const now = new Date();
                const year = now.getFullYear();
                const month = String(now.getMonth() + 1).padStart(2, '0');
                const day = String(now.getDate()).padStart(2, '0');
                const hours = String(now.getHours()).padStart(2, '0');
                const minutes = String(now.getMinutes()).padStart(2, '0');
                finalName = `${year}-${month}-${day} | ${hours}${minutes}`;
            }
            
            showLoading('正在创建存档...');
            
            const result = await apiCall('saves', 'POST', {
                name: finalName,
                description: description
            });
            
            if (result.success) {
                showToast('成功', '存档创建成功', 'success');
                
                // 清空输入框
                saveNameInput.value = '';
                saveDescriptionInput.value = '';
                
                // 刷新列表和状态
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

    /**
     * renameSave - 重命名存档（通过重命名模态框触发）
     * 
     * @param {string} oldTagName - 旧的存档标签名
     * @param {string} newName - 新的存档名称
     * @param {string} description - 新的存档描述
     */
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

    // =========================== 授权与登出 ===========================

    /**
     * authorize - 执行仓库授权流程
     * 
     * 向后端发送授权请求，验证 GitHub 仓库的连接和权限。
     * 
     * @param {string} repoUrl - GitHub 仓库 URL
     * @param {string} displayName - 用户显示名称
     * @param {string} branch - 目标分支名
     */
    async function authorize(repoUrl, displayName, branch) {
        try {
            if (!repoUrl) {
                showToast('错误', '仓库 URL 不能为空', 'error');
                return;
            }

            showLoading('正在授权并连接仓库...');

            const result = await apiCall('authorize', 'POST', {
                branch: branch
            });

            if (result.success) {
                isAuthorized = true;
                updateAuthUI(true);
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

            // 在授权状态区域显示错误信息
            authStatus.innerHTML = `<i class="bi bi-x-circle-fill text-danger me-2"></i>授权失败: ${error.message}`;
            authStatus.classList.remove('alert-success');
            authStatus.classList.add('alert-danger');
            authStatus.style.display = 'block';

            showToast('错误', `授权失败: ${error.message}`, 'error');
        }
    }

    /**
     * logout - 断开仓库连接
     * 
     * 清除后端 token 和授权状态，恢复 UI 到未授权状态。
     */
    async function logout() {
        try {
            showLoading('正在断开连接...');

            // 清除后端配置中的 token 和授权状态
            await apiCall('config', 'POST', {
                github_token: '',
                is_authorized: false
            });

            isAuthorized = false;
            initialConfigHasToken = false;
            updateAuthUI(false);

            hideLoading();
            showToast('成功', '已断开与仓库的连接', 'success');
        } catch (error) {
            hideLoading();
            console.error('断开连接失败:', error);
            showToast('错误', `断开连接失败: ${error.message}`, 'error');
        }
    }

    // =========================== Stash 操作 ===========================

    /**
     * applyStash - 应用（恢复）临时 stash 到工作区
     * 
     * 加载存档时如果用户有未保存的更改，会自动 stash。
     * 此函数将这些更改恢复到工作区。
     */
    async function applyStash() {
        try {
            showLoading('正在恢复临时更改...');
            
            const result = await apiCall('stash/apply', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已恢复', 'success');
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

    /**
     * discardStash - 丢弃临时 stash（不恢复更改）
     */
    async function discardStash() {
        try {
            showLoading('正在丢弃临时更改...');
            
            const result = await apiCall('stash/discard', 'POST');
            
            if (result.success) {
                stashNotification.style.display = 'none';
                showToast('成功', '临时更改已丢弃', 'success');
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

    // =========================== 覆盖存档 ===========================

    /**
     * overwriteSave - 用当前本地数据覆盖指定的云存档
     * 
     * 这是一个危险操作，会永久替换云端存档的内容。
     * 调用前需要通过确认对话框获得用户确认。
     * 
     * @param {string} tagName - 要覆盖的存档标签名
     */
    async function overwriteSave(tagName) {
        try {
            showLoading('正在覆盖存档...');
            
            const result = await apiCall(`saves/${tagName}/overwrite`, 'POST');
            
            if (result.success) {
                showToast('成功', '存档已成功覆盖', 'success');
                await loadSavesList();   // 刷新存档列表
                await refreshStatus();   // 刷新状态
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

    // =========================== 搜索与排序 ===========================

    /**
     * filterAndSortSaves - 根据搜索词和排序方式过滤并排序存档列表
     * 
     * 搜索：在存档名称和描述中进行不区分大小写的模糊匹配
     * 排序选项：
     *   - updated-desc: 按更新时间降序（最新在前）
     *   - updated-asc: 按更新时间升序（最旧在前）
     *   - name-asc: 名称 A-Z
     *   - name-desc: 名称 Z-A
     * 
     * 过滤和排序后重新渲染存档列表。
     */
    function filterAndSortSaves() {
        if (!currentSaves || currentSaves.length === 0) return;
        
        const searchTerm = searchBox.value.toLowerCase();
        const sortMethod = sortSelector.value;
        
        // 过滤：搜索词匹配名称或描述
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
                case 'updated-desc':
                    return new Date(b.updatedAt) - new Date(a.updatedAt);
                case 'updated-asc':
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

    // =========================== 配置保存 ===========================

    /**
     * saveConfiguration - 保存基本配置（仓库 URL、Token、显示名称、分支）
     * 
     * 注意：此函数只保存配置信息，不进行授权验证。
     * 授权验证由 authorize() 函数完成。
     * 
     * @returns {Promise<boolean>} - 是否保存成功
     */
    async function saveConfiguration() {
        const repoUrl = repoUrlInput.value.trim();
        const token = githubTokenInput.value.trim();
        const displayName = displayNameInput.value.trim();
        const branch = branchInput.value.trim() || 'main';

        try {
            showLoading('正在保存配置...');
            const result = await apiCall('config', 'POST', {
                repo_url: repoUrl,
                github_token: token,
                display_name: displayName,
                branch: branch
            });

            if (result.success) {
                showToast('成功', '配置已保存', 'success');
                branchInput.value = branch;

                // 更新 token 输入框状态
                if (token) {
                    initialConfigHasToken = true;
                    githubTokenInput.placeholder = "访问令牌已保存";
                    githubTokenInput.value = "";
                } else if (!token && !initialConfigHasToken) {
                    githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
                    githubTokenInput.value = "";
                } else if (!token && initialConfigHasToken) {
                    githubTokenInput.placeholder = "访问令牌已保存";
                    githubTokenInput.value = "";
                }

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

    /**
     * saveAutoSaveConfiguration - 保存定时自动存档设置
     * 
     * 包括：启用状态、间隔时间、目标标签、存档模式、时区偏移
     * 
     * 验证逻辑：
     *   - 覆盖模式必须指定目标标签
     * 
     * @returns {Promise<boolean>} - 是否保存成功
     */
    async function saveAutoSaveConfiguration() {
        const enabled = autoSaveEnabledSwitch.checked;
        const interval = parseInt(autoSaveIntervalInput.value, 10) || 30;
        const targetTag = autoSaveTargetTagInput.value.trim();
        const mode = autoSaveModeCreateRadio.checked ? 'create' : 'overwrite';
        
        // 获取浏览器时区偏移（分钟），用于创建模式的存档命名
        // new Date().getTimezoneOffset() 返回 UTC 与本地时间的分钟差
        // 取反得到本地时间相对于 UTC 的偏移
        const timezoneOffset = -new Date().getTimezoneOffset();

        // 覆盖模式必须提供目标标签
        if (enabled && mode === 'overwrite' && !targetTag) {
            showToast('警告', '覆盖模式下，启用定时存档时必须指定一个要覆盖的目标存档标签。', 'warning');
            return false;
        }

        try {
            showLoading('正在保存定时存档设置...');
            const result = await apiCall('config', 'POST', {
                repo_url: repoUrlInput.value.trim(),
                github_token: githubTokenInput.value.trim(),
                display_name: displayNameInput.value.trim(),
                branch: branchInput.value.trim() || 'main',
                autoSaveEnabled: enabled,
                autoSaveInterval: interval,
                autoSaveTargetTag: targetTag,
                autoSaveMode: mode,
                autoSaveTimezoneOffset: timezoneOffset
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

    // =========================== 确认对话框 ===========================

    /**
     * showConfirmDialog - 显示通用的确认对话框
     * 
     * 用于危险操作前的二次确认（删除、覆盖、加载存档等）。
     * 
     * 工作原理：
     *   1. 设置对话框标题和消息内容
     *   2. 保存回调函数到 confirmCallback 变量
     *   3. 根据类型设置确认按钮样式（danger/primary）
     *   4. 显示对话框
     * 
     * @param {string} title - 对话框标题
     * @param {string} message - 对话框消息（支持 HTML）
     * @param {Function} callback - 确认后执行的回调函数
     * @param {string} confirmButtonType - 确认按钮类型 (danger|primary|secondary)
     */
    function showConfirmDialog(title, message, callback, confirmButtonType = 'danger') { 
        const titleElement = document.getElementById('confirmModalLabel');
        const messageElement = document.getElementById('confirm-message');

        if (titleElement) {
            titleElement.textContent = title;
        } else {
            console.error('[Cloud Saves UI] Confirm dialog title element (confirmModalLabel) not found!');
        }

        if (messageElement) {
            messageElement.innerHTML = message;
        } else {
            console.error('[Cloud Saves UI] Confirm dialog message element (confirm-message) not found!');
        }
        
        // 保存回调函数
        confirmCallback = callback;
        
        // 设置确认按钮样式
        confirmActionBtn.classList.remove('btn-danger', 'btn-primary', 'btn-success', 'btn-warning', 'btn-secondary'); 
        if (confirmButtonType === 'danger') {
            confirmActionBtn.classList.add('btn-danger');
        } else if (confirmButtonType === 'primary') {
            confirmActionBtn.classList.add('btn-primary');
        } else {
            confirmActionBtn.classList.add('btn-secondary'); 
        }
        
        // 显示对话框
        if (confirmModal && typeof confirmModal.show === 'function') {
            confirmModal.show();
        } else {
            console.error('[Cloud Saves UI] Confirm dialog modal instance (confirmModal) is invalid or missing!');
            showToast('错误', '无法显示确认对话框', 'error');
        }
    }

    // =========================== 安全事件绑定工具 ===========================

    /**
     * safeAddEventListener - 安全的事件绑定封装
     * 
     * 在绑定事件前检查 DOM 元素是否存在，如果不存在则记录错误日志，
     * 避免因 HTML 元素缺失导致的运行时错误。
     * 
     * @param {HTMLElement|null} element - DOM 元素
     * @param {string} event - 事件名称 (如 'click')
     * @param {Function} handler - 事件处理函数
     * @param {string} elementIdForLogging - 用于日志记录的元素 ID
     */
    function safeAddEventListener(element, event, handler, elementIdForLogging) {
        if (element) {
            element.addEventListener(event, handler);
        } else {
            console.error(`[Cloud Saves UI] Element not found for ID: ${elementIdForLogging}. Cannot add event listener.`);
        }
    }

    // =========================== 事件监听器注册 ===========================

    // --- 初始化仓库按钮 ---
    safeAddEventListener(initRepoBtn, 'click', () => {
        showConfirmDialog(
            '确认强制初始化仓库',
            '<strong>警告：此操作将删除 data 目录下的现有 Git 历史 (如果存在)！</strong><br>确定要强制初始化本地 Git 仓库并配置远程地址吗？',
            initializeRepository,
            'danger'
        );
    }, 'init-repo-btn');

    // --- 配置按钮（只保存配置） ---
    safeAddEventListener(configureBtn, 'click', saveConfiguration, 'configure-btn');

    // --- 授权并连接按钮 ---
    safeAddEventListener(authorizeBtn, 'click', async () => {
        const repoUrl = repoUrlInput.value.trim();
        const tokenInputValue = githubTokenInput.value.trim();
        const displayName = displayNameInput.value.trim();
        const branch = branchInput.value.trim() || 'main';

        // 验证必要条件
        if (!repoUrl) {
            showToast('错误', '仓库 URL 不能为空', 'error');
            return;
        }
        // 如果用户输入了新 token，提示先保存
        if (tokenInputValue && tokenInputValue !== "") {
            showToast('提示', '检测到新的访问令牌输入，请先点击"配置"按钮保存新令牌，然后再点击"授权并连接"。', 'info');
            return;
        }
        // 验证是否有已保存的 token
        if (!tokenInputValue && !initialConfigHasToken) {
            showToast('错误', 'GitHub 访问令牌不能为空，请在上方输入或点击"配置"保存。', 'error');
            return;
        }

        await authorize(repoUrl, displayName, branch);
    }, 'authorize-btn');

    // --- 断开连接按钮 ---
    safeAddEventListener(logoutBtn, 'click', () => {
        showConfirmDialog('确认断开连接', '您确定要断开与仓库的连接吗？这将不会删除任何数据。', logout, 'primary');
    }, 'logout-btn');

    // --- 创建存档按钮 ---
    safeAddEventListener(createSaveBtn, 'click', () => {
        createSave(saveNameInput.value, saveDescriptionInput.value);
    }, 'create-save-btn');

    // --- 确认重命名按钮（模态框中） ---
    safeAddEventListener(confirmRenameBtn, 'click', () => {
        renameSave(renameTagNameInput.value, renameNewNameInput.value, renameDescriptionInput.value);
        renameModal.hide();
    }, 'confirm-rename-btn');

    // --- 确认对话框的确认按钮 ---
    safeAddEventListener(confirmActionBtn, 'click', () => {
        // 执行之前通过 showConfirmDialog 注册的回调函数
        if (typeof confirmCallback === 'function') {
            confirmCallback();
        }
        confirmModal.hide();
    }, 'confirm-action-btn');

    // --- 刷新存档列表按钮 ---
    safeAddEventListener(refreshSavesBtn, 'click', loadSavesList, 'refresh-saves-btn');

    // --- 搜索框输入事件（实时过滤） ---
    safeAddEventListener(searchBox, 'input', filterAndSortSaves, 'search-box');

    // --- 排序下拉框变更事件 ---
    safeAddEventListener(sortSelector, 'change', filterAndSortSaves, 'sort-selector');

    // --- 应用 Stash 按钮 ---
    safeAddEventListener(applyStashBtn, 'click', applyStash, 'apply-stash-btn');

    // --- 丢弃 Stash 按钮（需要确认） ---
    safeAddEventListener(discardStashBtn, 'click', () => {
        showConfirmDialog('确认丢弃临时更改', '您确定要丢弃所有临时保存的更改吗？此操作无法撤销。', discardStash, 'danger');
    }, 'discard-stash-btn');

    // --- 自动存档启用开关 ---
    safeAddEventListener(autoSaveEnabledSwitch, 'change', () => {
        // 切换选项区域的显示/隐藏
        autoSaveOptionsDiv.style.display = autoSaveEnabledSwitch.checked ? 'flex' : 'none';
    }, 'auto-save-enabled');

    // --- 自动存档模式：覆盖 ---
    safeAddEventListener(autoSaveModeOverwriteRadio, 'change', () => {
        if (autoSaveModeOverwriteRadio.checked) {
            autoSaveTargetTagRow.style.display = '';  // 显示目标标签输入
            autoSaveModeHint.textContent = '覆盖模式：每次自动存档将覆盖指定的已有存档标签。';
        }
    }, 'auto-save-mode-overwrite');

    // --- 自动存档模式：创建 ---
    safeAddEventListener(autoSaveModeCreateRadio, 'change', () => {
        if (autoSaveModeCreateRadio.checked) {
            autoSaveTargetTagRow.style.display = 'none';  // 隐藏目标标签输入
            autoSaveModeHint.textContent = '创建模式：每次自动存档将创建新存档（命名格式：YYYY-MM-DD - HHMM (Auto Save)），使用浏览器时区。';
        }
    }, 'auto-save-mode-create');

    // --- 保存定时存档设置按钮 ---
    safeAddEventListener(saveAutoSaveSettingsBtn, 'click', saveAutoSaveConfiguration, 'save-auto-save-settings-btn');

    // --- 检查更新按钮 ---
    safeAddEventListener(checkUpdateBtn, 'click', checkAndApplyUpdate, 'check-update-btn');

    // =========================== 初始化仓库 ===========================

    /**
     * initializeRepository - 强制重新初始化本地 Git 仓库
     * 
     * 删除 data 目录下现有的 .git 目录，然后重新执行 git init。
     * 这是一个破坏性操作，需要用户确认。
     */
    async function initializeRepository() {
        try {
            showLoading('正在初始化仓库...');
            const result = await apiCall('initialize', 'POST');
            
            if (result.success) {
                let message = result.message || '仓库初始化成功';
                if (result.warning) {
                    showToast('警告', message, 'warning');
                } else {
                    showToast('成功', message, 'success');
                }
                showToast('提示', '初始化完成，请点击 **授权并连接** 按钮以验证并同步远程仓库。', 'info');
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

    // =========================== 检查插件更新 ===========================

    /**
     * checkAndApplyUpdate - 检查插件自身是否有更新
     * 
     * 使用插件目录的 Git 仓库检查是否有新提交。
     * 如果有更新，自动执行 git pull。
     * 
     * 可能的状态：
     *   - not_git_repo: 插件不是通过 Git 安装的，无法自动更新
     *   - latest: 已是最新版本
     *   - updated: 更新成功，需要重启 SillyTavern
     */
    async function checkAndApplyUpdate() {
        try {
            showLoading('正在检查插件更新...');
            const result = await apiCall('update/check-and-pull', 'POST');

            if (result.success) {
                let message = result.message || '操作完成';
                let type = 'info';
                if (result.status === 'latest') {
                    type = 'success';
                    message = '插件已是最新版本。';
                } else if (result.status === 'updated') {
                    type = 'success';
                    message = '插件更新成功！请务必重启 SillyTavern 服务以应用更改。';
                } else if (result.status === 'not_git_repo') {
                    type = 'warning';
                    message = '无法自动更新：插件似乎不是通过 Git 安装的。';
                }
                showToast('检查更新', message, type);
            } else {
                showToast('更新失败', result.message || '检查或应用更新时发生未知错误。', 'error');
            }

            hideLoading();
        } catch (error) {
            hideLoading();
            console.error('检查更新失败:', error);
            showToast('错误', `检查更新时发生错误: ${error.message}`, 'error');
        }
    }

    // =========================== Token 输入框交互优化 ===========================

    /**
     * Token 输入框获得焦点时：
     * 如果占位符显示"已保存"，替换为提示输入新 token 的文字
     */
    safeAddEventListener(githubTokenInput, 'focus', () => {
        if (githubTokenInput.placeholder === "访问令牌已保存") {
            githubTokenInput.placeholder = "输入新令牌以覆盖...";
        }
    }, 'github-token-focus');

    /**
     * Token 输入框失去焦点时：
     * 如果用户清空了输入框，根据是否有已保存的 token 恢复对应的占位符文字
     */
    safeAddEventListener(githubTokenInput, 'blur', () => {
        if (githubTokenInput.value === "" && initialConfigHasToken) {
            githubTokenInput.placeholder = "访问令牌已保存";
        } else if (githubTokenInput.value === "" && !initialConfigHasToken) {
            githubTokenInput.placeholder = "例如: ghp_xxxxxxxxxxxx";
        }
    }, 'github-token-blur');

    // =========================== 初始化启动 ===========================
    // 页面加载完成后立即执行初始化
    init();

}); // DOMContentLoaded 结束
