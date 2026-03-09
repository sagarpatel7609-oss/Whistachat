let socket;
try {
    socket = io();
} catch (e) {
    console.error("Socket.io not found. Ensure you are accessing via http://localhost:3000 and the server is running.");
}
const screens = {
    login: document.getElementById('login-screen'),
    setup: document.getElementById('setup-username-screen'),
    home: document.getElementById('home-screen'),
    chat: document.getElementById('chat-screen'),
    call: document.getElementById('call-screen'),
    profile: document.getElementById('profile-screen'),
    admin: document.getElementById('admin-screen')
};

const ROLE_POWER = {
    owner: 4,
    admin: 3,
    moderator: 2,
    user: 1,
    bot: 1
};

function hasPermissionFrontend(actorRole, targetRole) {
    return (ROLE_POWER[actorRole] || 1) > (ROLE_POWER[targetRole] || 1);
}

// --- AUTH & STATE LOGIC ---
let currentUser = null;
let isLoginMode = true;
let dbState = {
    users: [],
    posts: [],
    comments: [],
    messages: [],
    verification_requests: [],
    notifications: []
};

function switchScreen(screenId) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screenId].classList.add('active');
}

if (socket) {
    socket.on('db_update', (newState) => {
        Object.assign(dbState, newState);
        if (currentUser) {
            // refresh current user if updated
            const updatedMe = dbState.users.find(u => u.uid === currentUser.uid);
            if (updatedMe) currentUser = updatedMe;
        }
        renderFeed();
        if (currentPostForComments) renderComments();
        if (screens.home.classList.contains('active') && activeHomeTab === 'chats') renderChatsList();
        if (screens.profile.classList.contains('active')) loadUserProfile();
        if (screens.admin.classList.contains('active')) loadAdminDashboard();

        // Always sync counters independently if we are moderator+, 
        // regardless if the admin screen is visibly active, 
        // to prevent old counts from flashing when clicking the dashboard.
        if (currentUser && ROLE_POWER[currentUser.role] >= ROLE_POWER['moderator']) syncAdminCounters();
    });

    socket.on('users_update', (usersList) => {
        dbState.users = usersList;
        // Refresh Current Session
        if (currentUser) Object.assign(currentUser, dbState.users.find(u => u.uid === currentUser.uid));

        // Refresh Chat Lists for Avatars Dots instantly
        if (screens.home.classList.contains('active') && activeHomeTab === 'chats') renderChatsList();

        // Refresh Active Chat Header if viewing user directly
        if (screens.chat.classList.contains('active') && activeChatUser) {
            const upUser = dbState.users.find(u => u.uid === activeChatUser.uid);
            if (upUser) {
                activeChatUser = upUser;
                if (typeof updateChatHeaderStatus === 'function') updateChatHeaderStatus(upUser);
            }
        }
    });

    socket.on('connect', () => {
        // Automatically restore server-side socket.uid if server restarted
        if (currentUser && currentUser.email && currentUser.password) {
            socket.emit('login', { email: currentUser.email, pass: currentUser.password }, (res) => {
                if (res.success && res.dbState) {
                    Object.assign(dbState, res.dbState);
                }
            });
        }
    });
}

// Auto-Login Check (Remember Me)
document.addEventListener('DOMContentLoaded', () => {
    const savedSession = localStorage.getItem('whistachat_user_session');
    if (savedSession && socket) {
        try {
            const { email, pass } = JSON.parse(savedSession);
            if (email && pass) {
                // Instantly attempt login bypassing UI
                const authError = document.getElementById('auth-error');

                socket.emit('login', { email, pass }, (response) => {
                    if (response.success) {
                        currentUser = response.user;
                        if (response.dbState) Object.assign(dbState, response.dbState);
                        loadUserProfile();
                        switchScreen('home');
                        renderChatsList();
                    } else {
                        // Secret login failed (e.g., password changed, account deleted)
                        localStorage.removeItem('whistachat_user_session');
                        if (authError) {
                            authError.innerText = "Session expired. Please log in again.";
                            authError.style.display = 'block';
                        }
                    }
                });
            }
        } catch (e) {
            console.error("Failed to parse saved session", e);
            localStorage.removeItem('whistachat_user_session');
        }
    }
});

// Auth Toggle (Login vs Signup)
const toggleAuthModeBtn = document.getElementById('toggle-auth-mode');
const authToggleText = document.querySelector('.auth-toggle');

toggleAuthModeBtn.addEventListener('click', () => {
    isLoginMode = !isLoginMode;
    document.getElementById('auth-title').innerText = isLoginMode ? "Welcome Back" : "Create Account";
    document.getElementById('auth-submit-btn').innerText = isLoginMode ? "Login" : "Sign Up";
    document.getElementById('auth-error').style.display = 'none';

    if (isLoginMode) {
        authToggleText.childNodes[0].nodeValue = "Don't have an account? ";
        toggleAuthModeBtn.innerText = "Sign Up";
    } else {
        authToggleText.childNodes[0].nodeValue = "Already have an account? ";
        toggleAuthModeBtn.innerText = "Login";
    }
});

// Auth Submit
document.getElementById('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    console.log("Auth form submit event fired!");
    const authError = document.getElementById('auth-error');
    authError.style.display = 'none';
    authError.innerText = '';

    if (!socket) {
        authError.innerText = "Server not connected. Please ensure you are running the Node.js server via 'node server.js' and accessing via http://localhost:3000.";
        authError.style.display = 'block';
        return;
    }

    const email = document.getElementById('auth-email').value.trim();
    const pass = document.getElementById('auth-pass').value.trim();
    const rememberMe = document.getElementById('remember-me').checked;

    if (!email || !pass) {
        authError.innerText = "Please enter email and password.";
        authError.style.display = 'block';
        return;
    }

    const eventName = isLoginMode ? 'login' : 'signup';
    socket.emit(eventName, { email, pass }, (response) => {
        if (response.success) {
            currentUser = response.user;
            if (response.dbState) Object.assign(dbState, response.dbState);

            // Save login session if Remember Me is checked
            if (rememberMe) {
                localStorage.setItem('whistachat_user_session', JSON.stringify({ email, pass }));
            } else {
                localStorage.removeItem('whistachat_user_session'); // Clean up just in case
            }

            if (isLoginMode) {
                loadUserProfile();
                switchScreen('home');
                renderChatsList();
            } else {
                switchScreen('setup');
            }
        } else {
            authError.innerText = response.message || "Authentication failed.";
            authError.style.display = 'block';
        }
    });
});

// Password Show/Hide Toggle
document.getElementById('toggle-password').addEventListener('click', function () {
    const pwdInput = document.getElementById('auth-pass');
    if (pwdInput.type === 'password') {
        pwdInput.type = 'text';
        this.innerText = 'visibility';
    } else {
        pwdInput.type = 'password';
        this.innerText = 'visibility_off';
    }
});

// Setup Username
const usernameInput = document.getElementById('setup-username');
const completeSetupBtn = document.getElementById('complete-setup-btn');
const usernameStatusIcon = document.getElementById('username-status-icon');
const usernameHint = document.getElementById('username-hint');

usernameInput.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
    e.target.value = val;
    if (val.length < 3) {
        completeSetupBtn.disabled = true;
        return;
    }
    // Simplistic check on client, definitive check on server
    completeSetupBtn.disabled = false;
});

completeSetupBtn.addEventListener('click', () => {
    socket.emit('complete_setup', { username: usernameInput.value }, (response) => {
        if (response.success) {
            currentUser = response.user;
            loadUserProfile();
            switchScreen('home');
            renderChatsList();
        } else {
            alert(response.message || "Setup failed.");
        }
    });
});

// --- SOCIAL FEED LOGIC ---
let activeHomeTab = 'chats';
window.switchHomeTab = function (tabName) {
    activeHomeTab = tabName;
    document.getElementById('tab-btn-chats').classList.toggle('active', tabName === 'chats');
    document.getElementById('tab-btn-feed').classList.toggle('active', tabName === 'feed');

    document.getElementById('home-chats-view').classList.toggle('hidden', tabName !== 'chats');
    document.getElementById('home-feed-view').classList.toggle('hidden', tabName !== 'feed');

    const fabIcon = document.getElementById('home-fab-icon');
    fabIcon.innerText = tabName === 'chats' ? 'chat' : 'add_photo_alternate';

    document.getElementById('home-fab').onclick = () => {
        if (tabName === 'chats') {
            document.getElementById('user-search-input').focus();
        } else {
            document.getElementById('create-post-modal').classList.remove('hidden');
        }
    };

    if (tabName === 'feed') renderFeed();
    if (tabName === 'chats') renderChatsList();
}
// Default FAB click
document.getElementById('home-fab').onclick = () => { document.getElementById('user-search-input').focus(); };

window.closeModal = function (id) {
    document.getElementById(id).classList.add('hidden');
}

// Upload Post
const postFileInput = document.getElementById('post-file');
const postCaption = document.getElementById('post-caption');
const postHint = document.getElementById('post-file-hint');
const postPreviewContainer = document.getElementById('post-media-preview-container');
const postImgPreview = document.getElementById('post-image-preview');
const postVidPreview = document.getElementById('post-video-preview');

postFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    postPreviewContainer.style.display = 'none';
    postImgPreview.classList.add('hidden');
    postVidPreview.classList.add('hidden');
    postImgPreview.src = '';
    postVidPreview.src = '';

    if (!file) return;
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > 95) {
        postHint.innerText = `File too large (${sizeMB.toFixed(1)}MB). Max 95MB for posts.`;
        postHint.style.color = "var(--danger-red)";
        postFileInput.value = '';
    } else {
        postHint.innerText = `File OK.`;
        postHint.style.color = "var(--success-green)";

        // Show Local Preview natively before it uploads
        const objectUrl = URL.createObjectURL(file);
        postPreviewContainer.style.display = 'block';
        if (file.type.startsWith('video/')) {
            postVidPreview.src = objectUrl;
            postVidPreview.classList.remove('hidden');
        } else {
            postImgPreview.src = objectUrl;
            postImgPreview.classList.remove('hidden');
        }
    }
});

document.getElementById('submit-post-btn').addEventListener('click', () => {
    if (currentUser && (currentUser.isBlocked || currentUser.isBanned)) {
        showToastNotification('Action Blocked', 'You cannot create posts while your account is banned or blocked.', 'system');
        closeModal('create-post-modal');
        return;
    }
    const file = postFileInput.files[0];
    const caption = postCaption.value.trim();
    if (!file && !caption) return alert("Please add a file or caption.");

    const processUpload = (dataUrl) => {
        socket.emit('create_post', {
            id: 'p_' + Date.now(),
            uid: currentUser.uid,
            username: currentUser.username,
            avatarUrl: currentUser.avatarUrl,
            caption: caption,
            mediaUrl: dataUrl,
            likes: [],
            createdAt: Date.now()
        });

        closeModal('create-post-modal');
        postFileInput.value = '';
        postCaption.value = '';
        postHint.innerText = '';
        postPreviewContainer.style.display = 'none';
        postImgPreview.src = '';
        postVidPreview.src = '';
    };

    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => processUpload(e.target.result);
        reader.readAsDataURL(file);
    } else {
        processUpload(null);
    }
});

function renderFeed() {
    const container = document.getElementById('social-feed-container');
    container.innerHTML = '';

    dbState.posts.forEach(post => {
        const isLiked = post.likes.includes(currentUser.uid);
        const canDelete = post.uid === currentUser.uid || ROLE_POWER[currentUser.role] >= ROLE_POWER['moderator'];
        const postComments = dbState.comments.filter(c => c.postId === post.id).length;

        let mediaHtml = '';
        if (post.mediaUrl) {
            if (post.mediaUrl.startsWith('data:video/')) {
                mediaHtml = `<video src="${post.mediaUrl}" controls class="post-media" style="width: 100%; border-radius: 8px; margin-top: 10px;"></video>`;
            } else {
                mediaHtml = `<img src="${post.mediaUrl}" class="post-media" style="width: 100%; border-radius: 8px; margin-top: 10px;">`;
            }
        }

        const card = document.createElement('div');
        card.id = 'post_' + post.id;
        card.className = 'post-card';
        card.innerHTML = `
            <div class="post-header">
                <img src="${post.avatarUrl || 'https://i.pravatar.cc/100?img=12'}" style="cursor:pointer;" onclick="openUserProfile('${post.uid}')">
                <h5 style="cursor:pointer;" onclick="openUserProfile('${post.uid}')">@${post.username}</h5>
            </div>
            ${mediaHtml}
            <div class="post-actions">
                <div style="display: flex; gap: 15px;">
                    <button class="icon-btn" onclick="toggleLike('${post.id}')" style="color: ${isLiked ? 'var(--danger-red)' : 'var(--text-main)'}">
                        <span class="material-symbols-rounded">${isLiked ? 'favorite' : 'favorite_border'}</span>
                        <span style="font-size: 14px; margin-left: 5px;">${post.likes.length}</span>
                    </button>
                    <button class="icon-btn" onclick="openComments('${post.id}')"><span class="material-symbols-rounded">chat_bubble_outline</span>
                        <span style="font-size: 14px; margin-left: 5px;">${postComments}</span>
                    </button>
                </div>
                ${canDelete ? `<button class="icon-btn" onclick="deletePost('${post.id}')"><span class="material-symbols-rounded text-danger">delete</span></button>` : ''}
            </div>
            <div class="post-caption">
                <span>@${post.username}</span> ${post.caption}
            </div>
        `;
        container.appendChild(card);
    });
}

window.deletePost = function (postId) {
    if (!confirm("Delete this post?")) return;
    socket.emit('delete_post', postId);
}

window.toggleLike = function (postId) {
    if (currentUser && (currentUser.isBlocked || currentUser.isBanned)) {
        showToastNotification('Action Blocked', 'You cannot like posts while your account is banned or blocked.', 'system');
        return;
    }
    socket.emit('toggle_like', { postId, uid: currentUser.uid });
}

// Comments Logic
let currentPostForComments = null;

window.openComments = function (postId) {
    currentPostForComments = postId;
    document.getElementById('comments-modal').classList.remove('hidden');
    renderComments();
}

window.openPostComments = function (postId) { // Wrapper for consistency with notifications
    openComments(postId);
}

function renderComments() {
    const list = document.getElementById('comments-list');
    list.innerHTML = '';
    const comments = dbState.comments.filter(c => c.postId === currentPostForComments);

    if (comments.length === 0) {
        list.innerHTML = '<p class="text-muted" style="text-align:center; margin-top: 20px;">No comments yet.</p>';
        return;
    }

    // Helper function to recursively render comments
    function renderCommentThread(comment, level) {
        list.appendChild(createCommentElement(comment, level));
        const replies = comments.filter(reply => reply.replyToId === comment.id);
        replies.forEach(reply => renderCommentThread(reply, level + 1));
    }

    const topLevelComments = comments.filter(c => !c.replyToId);
    topLevelComments.forEach(c => renderCommentThread(c, 0));
}

let activeReplyToId = null;

function createCommentElement(c, level) {
    const canEdit = c.uid === currentUser.uid;
    const canDelete = c.uid === currentUser.uid || ROLE_POWER[currentUser.role] >= ROLE_POWER['moderator'];
    const likesCount = (c.likes || []).length;
    const isLiked = (c.likes || []).includes(currentUser.uid);

    const item = document.createElement('div');
    item.className = 'comment-item';

    // Increased indent for nested replies up to a max limit to avoid overflowing UI
    const indent = Math.min(level * 30, 90);
    if (level > 0) {
        item.style.marginLeft = `${indent}px`;
        item.style.borderLeft = '2px solid var(--border-glass)';
        item.style.paddingLeft = '10px';
    }

    item.innerHTML = `
        <img src="${c.avatarUrl}" style="cursor:pointer;" onclick="openUserProfile('${c.uid}')">
        <div class="comment-content">
            <h6><span style="cursor:pointer;" onclick="openUserProfile('${c.uid}')">@${c.username}</span> ${c.isEdited ? '<span style="font-size:10px; opacity:0.5;">(edited)</span>' : ''}</h6>
            <p>${c.text}</p>
            <div class="comment-actions">
                <span class="comment-action ${isLiked ? 'liked' : ''}" onclick="toggleCommentLike('${c.id}')" style="display:flex; align-items:center; gap:3px;">
                    <span class="material-symbols-rounded" style="font-size:14px;">favorite</span> ${likesCount}
                </span>
                <span class="comment-action" onclick="setReplyTo('${c.id}', '${c.username}')">Reply</span>
                <span class="comment-action" onclick="openReportModal('comment', '${c.id}')" style="color: var(--danger-red);">Report</span>
                ${canEdit ? `<span class="comment-action" onclick="editComment('${c.id}')">Edit</span>` : ''}
                ${canDelete ? `<span class="comment-action" onclick="deleteComment('${c.id}')">Delete</span>` : ''}
            </div>
        </div>
    `;
    return item;
}

window.toggleCommentLike = function (commentId) {
    if (currentUser && (currentUser.isBlocked || currentUser.isBanned)) {
        showToastNotification('Action Blocked', 'You cannot like comments while your account is banned or blocked.', 'system');
        return;
    }
    socket.emit('toggle_comment_like', { commentId, uid: currentUser.uid });
};

window.setReplyTo = function (commentId, username) {
    activeReplyToId = commentId;
    const input = document.getElementById('comment-input');
    input.placeholder = `Replying to @${username}...`;
    input.focus();
}

window.clearReply = function () {
    activeReplyToId = null;
    const input = document.getElementById('comment-input');
    input.placeholder = "Add a comment...";
}

const sendCommentBtn = document.getElementById('send-comment-btn');
const commentInput = document.getElementById('comment-input');

function sendCommentLogic() {
    if (currentUser && (currentUser.isBlocked || currentUser.isBanned)) {
        showToastNotification('Action Blocked', 'You cannot comment while your account is banned or blocked.', 'system');
        commentInput.value = '';
        clearReply();
        closeModal('comments-modal');
        return;
    }
    const text = commentInput.value.trim();
    if (!text || !currentPostForComments) return;

    socket.emit('add_comment', {
        id: 'c_' + Date.now(),
        postId: currentPostForComments,
        uid: currentUser.uid,
        username: currentUser.username,
        avatarUrl: currentUser.avatarUrl,
        text: text,
        isEdited: false,
        likes: [],
        replyToId: activeReplyToId
    });

    commentInput.value = '';
    clearReply();
}

sendCommentBtn.onclick = sendCommentLogic;
commentInput.onkeypress = (e) => {
    if (e.key === 'Enter') sendCommentLogic();
};

window.editComment = function (id) {
    const c = dbState.comments.find(c => c.id === id);
    if (!c) return;
    const newText = prompt("Edit comment:", c.text);
    if (newText !== null && newText.trim() !== '') {
        socket.emit('edit_comment', { id, text: newText });
    }
}

window.deleteComment = function (id) {
    if (!confirm("Delete this comment?")) return;
    socket.emit('delete_comment', id);
}

// Reporting Logic
let currentReportTarget = null;
window.openReportModal = function (targetType, targetId) {
    currentReportTarget = { targetType, targetId };
    document.getElementById('report-modal').classList.remove('hidden');
}

document.getElementById('submit-report-btn').addEventListener('click', () => {
    if (!currentReportTarget) return;
    const reason = document.getElementById('report-reason').value;
    socket.emit('report_content', {
        ...currentReportTarget,
        reason
    }, (res) => {
        if (res && res.success) {
            showToastNotification('Report Submitted', 'Thank you for keeping the community safe.', 'system');
        } else {
            showToastNotification('Error', 'Failed to submit report.', 'system');
        }
    });
    closeModal('report-modal');
    currentReportTarget = null;
});

// Avatar change logic
const avatarUpload = document.getElementById('avatar-upload');
document.getElementById('change-avatar-btn').addEventListener('click', () => {
    avatarUpload.click();
});
avatarUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > 5) {
        alert(`Profile picture too large (${sizeMB.toFixed(1)}MB). Max size is 5MB.`);
        avatarUpload.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        socket.emit('update_profile', { avatarUrl: e.target.result });
    };
    reader.readAsDataURL(file);
});

// --- PROFILE & VERIFICATION LOGIC ---
let activeProfileUser = null;

function loadUserProfile(targetUid = null) {
    const uid = targetUid || (activeProfileUser ? activeProfileUser.uid : currentUser.uid);
    const user = dbState.users.find(u => u.uid === uid);
    if (!user) return;

    activeProfileUser = user;
    const isMe = user.uid === currentUser.uid;

    document.getElementById('display-profile-name').innerHTML = `${user.displayName} ${user.isVerified ? '<span class="material-symbols-rounded verified-icon">verified</span>' : ''}`;
    document.getElementById('display-profile-handle').innerText = `@${user.username}`;
    document.getElementById('profile-img-element').src = user.avatarUrl;

    document.getElementById('display-bio').innerText = user.bio || 'No bio yet';
    document.getElementById('display-location').innerText = user.location || 'Earth';

    // About section (multi-line bio or description)
    const aboutEl = document.getElementById('display-about');
    if (aboutEl) aboutEl.innerText = user.about || 'Tell us about yourself...';

    document.getElementById('display-followers-count').innerText = user.followers ? user.followers.length : 0;
    document.getElementById('display-following-count').innerText = user.following ? user.following.length : 0;

    const followBtn = document.getElementById('btn-follow-user');
    const msgBtn = document.getElementById('btn-message-user');
    const notifBtn = document.getElementById('btn-view-notifications');
    const editDetailsBtns = document.querySelectorAll('.edit-profile-btn');
    const changeAvatarBtn = document.getElementById('change-avatar-btn');
    const reqBtn = document.getElementById('btn-request-verify');
    const statusText = document.getElementById('verify-status-text');
    const adminBtn = document.getElementById('btn-admin-dashboard');

    if (isMe) {
        followBtn.style.display = 'none';
        msgBtn.style.display = 'none';
        editDetailsBtns.forEach(btn => btn.style.display = 'inline-flex');
        changeAvatarBtn.style.display = 'inline-flex';
        if (ROLE_POWER[currentUser.role] >= ROLE_POWER['moderator']) adminBtn.classList.remove('hidden');
        else adminBtn.classList.add('hidden');

        document.getElementById('edit-username').value = user.username || '';
        document.getElementById('edit-bio').value = user.bio || '';
        document.getElementById('edit-about').value = user.about || ''; // New field
        document.getElementById('edit-location').value = user.location || '';

        if (user.isVerified) {
            reqBtn.style.display = 'none';
            statusText.innerText = "You are an officially verified user! ✨";
            statusText.style.color = 'var(--neon-cyan)';
        } else {
            const reqRef = dbState.verification_requests.find(r => r.uid === user.uid);
            if (reqRef && reqRef.status === 'pending') {
                reqBtn.innerText = "Pending";
                reqBtn.disabled = true;
                statusText.innerText = "Your request is under review.";
            } else {
                reqBtn.innerText = "Request";
                reqBtn.disabled = false;
                reqBtn.style.display = 'block';
                statusText.innerText = "Get the official glowing checkmark.";
                statusText.style.color = 'var(--text-muted)';
            }
        }
    } else {
        followBtn.style.display = 'block';
        msgBtn.style.display = 'inline-block';

        const isFollowing = (currentUser.following || []).includes(uid);
        followBtn.innerText = isFollowing ? 'Unfollow' : 'Follow';
        followBtn.className = isFollowing ? 'primary-btn danger-outline mt-4' : 'primary-btn mt-4';

        editDetailsBtns.forEach(btn => btn.style.display = 'none');
        changeAvatarBtn.style.display = 'none';
        adminBtn.classList.add('hidden');
        statusText.innerText = user.isVerified ? "Officially Verified Account" : "Standard Account";
        statusText.style.color = 'var(--text-muted)';

        // Admin Role Controls
        const adminControls = document.getElementById('admin-role-controls');
        const roleBtn = document.getElementById('btn-toggle-admin-role');

        // Hide by default unless specifically overridden below
        adminControls.classList.add('hidden');
        roleBtn.style.display = 'none';

        // High Level Hierarchy Access (Owners / Admins looking at lower users)
        if (hasPermissionFrontend(currentUser.role, user.role)) {
            adminControls.classList.remove('hidden');

            // Explicit logic to render Grant/Remove buttons. Only Owner/Admin can give Moderator/Admin roles. Mod cannot give Mod.
            if (ROLE_POWER[currentUser.role] >= ROLE_POWER['admin']) {
                roleBtn.style.display = 'block';

                if (user.role === 'user') {
                    // Quick promote to Moderator first
                    roleBtn.innerText = 'Promote to Moderator';
                    roleBtn.onclick = () => {
                        if (confirm(`Change ${user.username}'s role to moderator?`)) {
                            socket.emit('change_user_role', { targetUid: user.uid, newRole: 'moderator' }, (res) => {
                                if (res.success) { alert("Role updated!"); loadUserProfile(user.uid); }
                            });
                        }
                    };
                } else if (user.role === 'moderator' && ROLE_POWER[currentUser.role] >= ROLE_POWER['owner']) {
                    // Owner promoting Mod to Admin
                    roleBtn.innerText = 'Promote to Admin';
                    roleBtn.onclick = () => {
                        if (confirm(`Change ${user.username}'s role to admin?`)) {
                            socket.emit('change_user_role', { targetUid: user.uid, newRole: 'admin' }, (res) => {
                                if (res.success) { alert("Role updated!"); loadUserProfile(user.uid); }
                            });
                        }
                    };
                } else if (user.role === 'moderator' || user.role === 'admin') {
                    // Demotion down to User
                    roleBtn.innerText = 'Demote to User';
                    roleBtn.onclick = () => {
                        if (confirm(`Remove custom role from ${user.username}?`)) {
                            socket.emit('change_user_role', { targetUid: user.uid, newRole: 'user' }, (res) => {
                                if (res.success) { alert("Role updated!"); loadUserProfile(user.uid); }
                            });
                        }
                    };
                }
            }
        }
    }

    renderProfileFeed(uid);
}

window.openUserProfile = function (uid) {
    if (typeof uid === 'object') uid = null; // Ignore Event objects
    loadUserProfile(uid);
    switchScreen('profile');
    closeModal('comments-modal');
    closeModal('options-modal');
    closeModal('post-options-modal');
}

function renderProfileFeed(uid) {
    const container = document.getElementById('profile-feed-container');
    if (!container) return;
    container.innerHTML = '';
    const userPosts = dbState.posts.filter(p => p.uid === uid);
    if (userPosts.length === 0) {
        container.innerHTML = '<p class="text-muted" style="text-align:center; margin-top: 20px;">No posts yet.</p>';
        return;
    }
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(3, 1fr)';
    grid.style.gap = '8px';
    grid.style.marginTop = '20px';

    userPosts.forEach(post => {
        const img = document.createElement('img');
        img.src = post.mediaUrl || post.avatarUrl;
        img.style.width = '100%';
        img.style.aspectRatio = '1/1';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '8px';
        img.style.cursor = 'pointer';
        img.onclick = () => {
            switchScreen('home');
            switchHomeTab('feed');
            setTimeout(() => {
                const el = document.getElementById('post_' + post.id);
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 300);
        };
        grid.appendChild(img);
    });
    container.appendChild(grid);
}

document.getElementById('btn-request-verify').addEventListener('click', () => {
    if (currentUser.isVerified) return;
    socket.emit('request_verification');
    alert("Verification request sent to admins!");
});

document.getElementById('btn-logout').addEventListener('click', () => {
    currentUser = null;
    activeProfileUser = null;
    document.getElementById('auth-email').value = '';
    document.getElementById('auth-pass').value = '';

    // Clear persistent login on manual logout
    localStorage.removeItem('whistachat_user_session');

    switchScreen('login');
});

// Edit Profile Details Modal Logic
document.querySelectorAll('.edit-profile-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('edit-details-modal').classList.remove('hidden');
    });
});

const editLocationInp = document.getElementById('edit-location');
if (editLocationInp) {
    editLocationInp.addEventListener('blur', (e) => {
        const val = e.target.value.trim();
        const lowerVal = val.toLowerCase();
        const indianCities = ['ahmedabad', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad', 'pune', 'surat', 'jaipur'];
        if (indianCities.some(city => lowerVal === city)) {
            e.target.value = val.charAt(0).toUpperCase() + val.slice(1) + ', India';
        }
    });
}

document.getElementById('save-details-btn').addEventListener('click', () => {
    const bio = document.getElementById('edit-bio').value.trim();
    const about = document.getElementById('edit-about').value.trim();
    const location = document.getElementById('edit-location').value.trim();
    const usernameEdit = document.getElementById('edit-username');
    const updateData = { bio, about, location };

    if (usernameEdit && usernameEdit.value.trim().length > 2) {
        updateData.username = usernameEdit.value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    }

    socket.emit('update_profile', updateData, (res) => {
        if (res && !res.success) {
            alert(res.message || "Failed to update details.");
        } else {
            closeModal('edit-details-modal');
        }
    });

    // Optimistic close
    if (!updateData.username) closeModal('edit-details-modal');
});

// Follow user button logic
document.getElementById('btn-follow-user').addEventListener('click', () => {
    if (activeProfileUser && activeProfileUser.uid !== currentUser.uid) {
        socket.emit('toggle_follow', { targetUid: activeProfileUser.uid });
    }
});

// Profile Direct Message logic
document.getElementById('btn-message-user').addEventListener('click', () => {
    if (activeProfileUser && activeProfileUser.uid !== currentUser.uid) {
        openChatWithUser(activeProfileUser.uid);
    }
});

const openNotifModal = () => {
    const list = document.getElementById('notifications-list');
    list.innerHTML = '';

    if (dbState.notifications.length === 0) {
        list.innerHTML = '<p class="text-muted" style="text-align:center; margin-top: 20px;">No recent notifications.</p>';
    } else {
        // Sort newest first
        const sorted = [...dbState.notifications].reverse();
        sorted.forEach(notif => {
            const el = document.createElement('div');
            el.style.padding = '12px';
            el.style.borderBottom = '1px solid var(--border-glass)';
            el.style.cursor = 'pointer';
            el.innerHTML = `<strong>${notif.title}</strong><br><span class="text-muted" style="font-size: 14px;">${notif.body}</span>`;
            el.onclick = () => {
                closeModal('notifications-modal');
                if (notif.type === 'chat') {
                    openChatWithUser(notif.sourceId);
                } else if (notif.type === 'post' || notif.type === 'comment') {
                    openPostComments(notif.sourceId);
                } else if (notif.type === 'mention') {
                    const post = dbState.posts.find(p => p.id === notif.sourceId);
                    if (post) openPostComments(post.id);
                    else {
                        const comment = dbState.comments.find(c => c.id === notif.sourceId);
                        if (comment) openPostComments(comment.postId);
                    }
                }
            };
            list.appendChild(el);
        });
    }

    document.getElementById('notifications-modal').classList.remove('hidden');
};

const headerNotifBtn = document.getElementById('header-notif-btn');
if (headerNotifBtn) headerNotifBtn.addEventListener('click', openNotifModal);
const headerNotifBtnProfile = document.getElementById('header-notif-btn-profile');
if (headerNotifBtnProfile) headerNotifBtnProfile.addEventListener('click', openNotifModal);

// Ensure About section is correctly handled in loadUserProfile already added

// Notifications Permission Logic
const enableNotifsBtn = document.getElementById('btn-enable-notifications');
enableNotifsBtn.addEventListener('click', async () => {
    if (!("Notification" in window)) {
        alert("This browser does not support desktop notification");
        return;
    }

    const permission = await Notification.requestPermission();
    if (permission === "granted") {
        enableNotifsBtn.style.display = 'none';
        new Notification("Notifications Enabled!", {
            body: "You will now receive alerts for new messages, calls, and updates."
        });
    } else {
        alert("Notifications were denied.");
    }
});

// --- ADMIN DASHBOARD LOGIC ---
document.getElementById('btn-admin-dashboard').addEventListener('click', () => {
    loadAdminDashboard();
    switchScreen('admin');
});
document.getElementById('admin-back-btn').addEventListener('click', () => switchScreen('profile'));

function syncAdminCounters() {
    const humanUsers = dbState.users.filter(u => u.uid !== 'sys_bot');
    const totalUsersEl = document.getElementById('stat-total-users');
    if (totalUsersEl) totalUsersEl.innerText = humanUsers.length;

    const pendingReqs = dbState.verification_requests.filter(r => r.status === 'pending');
    const uniqueReqs = [];
    const seenUids = new Set();
    for (const req of pendingReqs) {
        if (!seenUids.has(req.uid)) {
            uniqueReqs.push(req);
            seenUids.add(req.uid);
        }
    }
    const pendingReqsEl = document.getElementById('stat-pending-req');
    if (pendingReqsEl) pendingReqsEl.innerText = uniqueReqs.length;

    const activeBannedUsers = dbState.users.filter(u => u.isBanned);
    const activeBansEl = document.getElementById('stat-active-bans');
    if (activeBansEl) activeBansEl.innerText = activeBannedUsers.length;

    return uniqueReqs;
}

function loadAdminDashboard() {
    const uniqueReqs = syncAdminCounters();

    const listEl = document.getElementById('admin-requests-list');
    listEl.innerHTML = '';


    if (uniqueReqs.length === 0) {
        listEl.innerHTML = '<p class="text-muted" style="text-align:center; padding: 20px;">No pending requests.</p>';
        return;
    }

    uniqueReqs.forEach(req => {
        const item = document.createElement('div');
        item.className = 'admin-req-item glass-panel';
        item.innerHTML = `
            <div class="admin-user-info" style="display:flex; align-items:center; gap:10px;">
                <img src="${req.avatar}" style="width:40px; border-radius:10px;">
                <div>
                    <h5>@${req.username}</h5>
                    <p style="font-size:12px; color:var(--text-muted)">Requested Verification</p>
                </div>
            </div>
            <div class="req-actions" style="margin-top:10px; display:flex; gap:10px;">
                <button class="small-btn success" onclick="handleVerify('${req.uid}', true)">Approve</button>
                <button class="small-btn danger" onclick="handleVerify('${req.uid}', false)">Reject</button>
            </div>
        `;
        // Append list
        listEl.appendChild(item);
    });

    if (activeAdminTab === 'reports') renderAdminReports();
    if (activeAdminTab === 'logs') renderAdminLogs();
}

let activeAdminTab = 'users';
window.switchAdminTab = function (tabName) {
    activeAdminTab = tabName;
    document.getElementById('tab-admin-users').classList.toggle('active', tabName === 'users');
    document.getElementById('tab-admin-reports').classList.toggle('active', tabName === 'reports');
    document.getElementById('tab-admin-logs').classList.toggle('active', tabName === 'logs');
    document.getElementById('tab-admin-bans').classList.toggle('active', tabName === 'bans');

    document.getElementById('admin-users-view').classList.toggle('hidden', tabName !== 'users');
    document.getElementById('admin-reports-view').classList.toggle('hidden', tabName !== 'reports');
    document.getElementById('admin-logs-view').classList.toggle('hidden', tabName !== 'logs');
    document.getElementById('admin-bans-view').classList.toggle('hidden', tabName !== 'bans');

    if (tabName === 'reports') renderAdminReports();
    if (tabName === 'logs') renderAdminLogs();
    if (tabName === 'bans') renderActiveBans();
}

window.handleVerify = function (uid, isApproved) {
    socket.emit('handle_verification', { uid, action: isApproved ? 'approve' : 'reject' }, (res) => {
        if (res && !res.success) {
            alert(res.message || "Failed. If you restarted the server recently, please refresh the page.");
        }
    });
};

// Admin Search Logic
const adminSearchInput = document.getElementById('admin-user-search-input');
const adminSearchResultsContainer = document.getElementById('admin-user-search-results');

function renderAdminUserResults(results) {
    if (!adminSearchResultsContainer) return;
    adminSearchResultsContainer.innerHTML = '';
    if (!results || results.length === 0) {
        adminSearchResultsContainer.innerHTML = '<p class="text-muted" style="padding: 10px;">No users found.</p>';
        return;
    }
    results.forEach(u => {
        const div = document.createElement('div');
        div.className = 'admin-user-item glass-panel';
        div.style.display = 'flex';
        div.style.flexDirection = 'column';
        div.style.gap = '10px';
        div.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <img src="${u.avatarUrl}" style="width:40px; height:40px; border-radius:10px; object-fit:cover;">
                <div>
                    <h5 style="margin:0;">@${u.username} ${u.isVerified ? '<span class="material-symbols-rounded verified-icon" style="font-size:14px;">verified</span>' : ''}</h5>
                    <p style="margin:0; font-size:12px; color:var(--text-muted)">${u.email} | ${u.role === 'owner' ? '👑 Owner' : u.role === 'admin' ? '🛡️ Admin' : u.role === 'moderator' ? '🔨 Mod' : u.role}</p>
                    ${u.isBanned ? '<span style="color:var(--danger-red); font-size:10px; font-weight:bold;">[BANNED]</span>' : ''}
                    ${u.isBlocked ? '<span style="color:var(--danger-red); font-size:10px; font-weight:bold;">[BLOCKED]</span>' : ''}
                </div>
            </div>
            <div style="display:flex; gap:5px; flex-wrap:wrap;">
                <button class="small-btn danger" onclick="adminActionUser('${u.uid}', 'delete')">Delete</button>
                <button class="small-btn danger-outline" onclick="adminActionUser('${u.uid}', 'warn')">Warn</button>
                <button class="small-btn ${u.isBanned ? 'success' : 'danger-outline'}" onclick="${u.isBanned ? `adminActionUser('${u.uid}', 'unban')` : `openBanModal('${u.uid}')`}">${u.isBanned ? 'Unban' : 'Ban'}</button>
                <button class="small-btn ${u.isBlocked ? 'success' : 'danger-outline'}" onclick="${u.isBlocked ? `adminActionUser('${u.uid}', 'unblock')` : `adminActionUser('${u.uid}', 'block')`}">${u.isBlocked ? 'Unblock' : 'Block'}</button>
                ${u.isVerified ? `<button class="small-btn danger-outline" onclick="adminActionUser('${u.uid}', 'unverify')">Unverify</button>` : ''}
            </div>
        `;
        adminSearchResultsContainer.appendChild(div);
    });
}

if (adminSearchInput) {
    adminSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (q.length === 0) {
            if (adminSearchResultsContainer) adminSearchResultsContainer.innerHTML = '';
            return;
        }
        socket.emit('admin_user_search', q, renderAdminUserResults);
    });
}

const adminTotalUsersBtn = document.getElementById('admin-total-users-btn');
if (adminTotalUsersBtn) {
    adminTotalUsersBtn.addEventListener('click', () => {
        if (adminSearchInput) adminSearchInput.value = '';
        socket.emit('admin_user_search', '', renderAdminUserResults);
    });
}

window.renderActiveBans = function () {
    const list = document.getElementById('admin-active-bans-list');
    list.innerHTML = '<p class="text-muted">Loading...</p>';

    socket.emit('admin_user_search', '', (results) => {
        list.innerHTML = '';
        if (!results || results.error) {
            list.innerHTML = '<p class="text-muted">Failed to load bans.</p>';
            return;
        }

        const bannedUsers = results.filter(u => u.isBanned);
        if (bannedUsers.length === 0) {
            list.innerHTML = '<p class="text-muted" style="padding: 10px;">No active bans found.</p>';
            return;
        }

        bannedUsers.forEach(u => {
            const div = document.createElement('div');
            div.className = 'glass-panel';
            div.style.padding = '15px';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'space-between';
            div.style.gap = '10px';

            let expiryText = 'Permanent';
            if (u.bannedUntil) {
                const expiresDate = new Date(u.bannedUntil);
                if (expiresDate.getTime() > Date.now()) {
                    expiryText = `Expires: ${expiresDate.toLocaleString()}`;
                } else {
                    expiryText = 'Expired (Pending Lift)';
                }
            }

            div.innerHTML = `
                <div style="display:flex; align-items:center; gap:10px;">
                    <img src="${u.avatarUrl}" style="width:40px; height:40px; border-radius:10px; object-fit:cover;">
                    <div>
                        <h5 style="margin:0;">@${u.username}</h5>
                        <p style="margin:0; font-size:12px; color:var(--text-muted)">${u.email}</p>
                        <p style="margin:0; font-size:12px; color:var(--danger-red); font-weight:bold;">${expiryText}</p>
                    </div>
                </div>
                <div style="display:flex; gap:10px;">
                    <button class="small-btn success" onclick="adminActionUser('${u.uid}', 'unban'); setTimeout(renderActiveBans, 300);">Unban</button>
                </div>
            `;
            list.appendChild(div);
        });
    });
};

const adminBansSearchInput = document.getElementById('admin-bans-search-input');
if (adminBansSearchInput) {
    adminBansSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim().toLowerCase();
        const items = document.getElementById('admin-active-bans-list').children;
        for (let item of items) {
            if (item.tagName.toLowerCase() !== 'div') continue;
            const text = item.innerText.toLowerCase();
            if (text.includes(q)) {
                item.style.display = 'flex';
            } else {
                item.style.display = 'none';
            }
        }
    });
}

window.adminActionUser = function (uid, action, extraParams = {}) {
    if (action !== 'warn' && !confirm(`Are you sure you want to perform action: ${action.toUpperCase()} on this user?`)) return;

    socket.emit('admin_action_user', { targetUid: uid, action, ...extraParams }, (res) => {
        if (res && res.success) {
            alert(`Action ${action} completed successfully.`);
            // Re-trigger search to update UI
            if (adminSearchInput && adminSearchInput.value) {
                adminSearchInput.dispatchEvent(new Event('input'));
            } else if (adminSearchInput) {
                socket.emit('admin_user_search', '', renderAdminUserResults);
            }
        } else {
            alert(res?.message || "Action failed.");
        }
    });
};

let currentBanTargetUid = null;
window.openBanModal = function (uid) {
    currentBanTargetUid = uid;
    document.getElementById('ban-modal').classList.remove('hidden');
}

document.getElementById('submit-ban-btn').addEventListener('click', () => {
    if (!currentBanTargetUid) return;
    const durVal = document.getElementById('ban-duration-select').value;
    const durationMs = durVal === 'permanent' ? null : parseInt(durVal);
    const reason = document.getElementById('ban-reason-input') ? document.getElementById('ban-reason-input').value.trim() : '';

    socket.emit('admin_action_user', { targetUid: currentBanTargetUid, action: 'ban', durationMs, reason }, (res) => {
        if (res && res.success) {
            alert(`User banned successfully.`);
            closeModal('ban-modal');
            if (document.getElementById('ban-reason-input')) document.getElementById('ban-reason-input').value = '';
            if (adminSearchInput && adminSearchInput.value) {
                adminSearchInput.dispatchEvent(new Event('input'));
            } else {
                socket.emit('admin_user_search', '', renderAdminUserResults);
            }
        } else {
            alert(res?.message || "Ban failed.");
        }
    });
});

// Logs and Reports Rendering
function renderAdminLogs() {
    const logsList = document.getElementById('admin-action-logs-list');
    if (!logsList) return;
    logsList.innerHTML = '';
    const logs = dbState.action_logs || [];

    if (logs.length === 0) {
        logsList.innerHTML = '<p class="text-muted" style="text-align:center;">No logs recorded yet.</p>';
        return;
    }

    const sortedLogs = [...logs].reverse(); // Newest first
    sortedLogs.forEach(log => {
        const item = document.createElement('div');
        item.className = 'glass-panel';
        item.style.padding = '12px';
        item.style.marginBottom = '5px';
        item.innerHTML = `
            <div style="font-size: 12px; color: var(--text-muted);">${new Date(log.timestamp).toLocaleString()}</div>
            <div style="font-size: 14px; margin-top: 5px;">
                <strong>Admin @${log.adminName}</strong> performed 
                <span style="color: var(--neon-cyan);">${log.actionType}</span> 
                on user <strong style="cursor:pointer;" onclick="openUserProfile('${log.targetUid}')">@${log.targetName}</strong>.
            </div>
        `;
        logsList.appendChild(item);
    });
}

window.resolveReport = function (reportId, status) {
    socket.emit('admin_resolve_report', { reportId, status }, (res) => {
        if (res && res.success) {
            alert(`Report marked as ${status}.`);
        } else {
            alert("Failed to update report status.");
        }
    });
}

function renderAdminReports() {
    const list = document.getElementById('admin-reports-list');
    if (!list) return;
    list.innerHTML = '';
    const reports = dbState.reports || [];

    if (reports.length === 0) {
        list.innerHTML = '<p class="text-muted" style="text-align:center;">No reports pending.</p>';
        return;
    }

    const sortedReports = [...reports].filter(r => r.status === 'open').reverse();
    if (sortedReports.length === 0) {
        list.innerHTML = '<p class="text-muted" style="text-align:center;">All reports resolved!</p>';
        return;
    }

    sortedReports.forEach(rep => {
        const item = document.createElement('div');
        item.className = 'glass-panel';
        item.style.padding = '12px';
        item.style.marginBottom = '8px';
        item.innerHTML = `
            <div style="font-size: 12px; color: var(--text-muted); display:flex; justify-content:space-between;">
                <span>Reported by @${rep.reporterName}</span>
                <span>${new Date(rep.timestamp).toLocaleDateString()}</span>
            </div>
            <div style="margin-top: 8px; font-size: 14px;">
                <strong>Reason:</strong> ${rep.reason}<br>
                <strong>Type:</strong> ${rep.targetType.toUpperCase()}<br>
                <strong>Target ID:</strong> <span style="font-family: monospace; font-size: 11px;">${rep.targetId}</span>
            </div>
            <div style="margin-top: 10px; display:flex; gap: 8px;">
                <button class="small-btn danger" onclick="resolveReport('${rep.reportId}', 'resolved')">Mark Resolved</button>
                <button class="small-btn danger-outline" onclick="resolveReport('${rep.reportId}', 'dismissed')">Dismiss</button>
                <!-- Shortcut action depending on targetType could be added here, e.g., view post -->
                ${rep.targetType === 'post' ? `<button class="small-btn" onclick="openPostComments('${rep.targetId}')">View Post</button>` : ''}
            </div>
        `;
        list.appendChild(item);
    });
}

// Admin Bot Management
const adminBotUploadInput = document.getElementById('admin-bot-upload-input');
if (adminBotUploadInput) {
    adminBotUploadInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const dataUrl = event.target.result;
            socket.emit('admin_update_bot_avatar', { avatarUrl: dataUrl }, (res) => {
                if (res && res.success) {
                    document.getElementById('admin-bot-avatar-preview').src = dataUrl;
                    alert("Whistachat.AI Profile Picture updated successfully!");
                } else {
                    alert("Failed to update bot avatar. Ensure you are an Admin.");
                }
            });
        };
        reader.readAsDataURL(file);
    });
}

// --- CHAT & SEARCH LOGIC ---
const searchInput = document.getElementById('user-search-input');
const searchResultsContainer = document.getElementById('user-search-results');
const chatListContainer = document.getElementById('chat-list-container');
let activeChatId = null;
let activeChatUser = null;

searchInput.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (q.length === 0) {
        searchResultsContainer.innerHTML = '';
        return;
    }
    socket.emit('search_users', q, (results) => {
        searchResultsContainer.innerHTML = '';
        results.forEach(u => {
            const div = document.createElement('div');
            div.className = 'chat-item';
            div.style.background = 'rgba(255,255,255,0.05)';
            div.innerHTML = `
                <div class="avatar"><img src="${u.avatarUrl}" alt="${u.username}"></div>
                <div class="chat-info">
                    <h4>${u.displayName} ${u.isVerified ? '<span class="material-symbols-rounded verified-icon" style="font-size:14px;">verified</span>' : ''}</h4>
                    <p>@${u.username}</p>
                </div>
            `;
            div.onclick = () => {
                searchInput.value = '';
                searchResultsContainer.innerHTML = '';
                openChatWithUser(u.uid);
            };
            searchResultsContainer.appendChild(div);
        });
    });
});

function renderChatsList() {
    const list = document.getElementById('chat-list-container');
    list.innerHTML = '';

    const myId = currentUser.uid;
    const uniqueUids = new Set();
    const latestMessages = {};

    // Filter messages for current user
    dbState.messages.forEach(msg => {
        if (msg.chatId.includes(myId)) {
            const ids = msg.chatId.replace('chat_', '');
            let partnerId = null;

            if (msg.chatId.includes('sys_bot')) {
                partnerId = 'sys_bot';
            } else {
                partnerId = msg.chatId.replace('chat_', '').replace(myId, '');
                if (partnerId.startsWith('_')) partnerId = partnerId.substring(1);
                if (partnerId.endsWith('_')) partnerId = partnerId.substring(0, partnerId.length - 1);
            }

            if (partnerId) {
                uniqueUids.add(partnerId);
                if (!latestMessages[partnerId] || msg.timestamp > latestMessages[partnerId].timestamp) {
                    latestMessages[partnerId] = msg;
                }
            }
        }
    });

    // If bot not in history but exists, add it as a default starter
    const botUser = dbState.users.find(u => u.uid === 'sys_bot');
    if (botUser && !uniqueUids.has('sys_bot')) {
        uniqueUids.add('sys_bot');
    }

    const usersIChatedWith = Array.from(uniqueUids).map(partnerId => {
        return dbState.users.find(u => u.uid === partnerId);
    }).filter(u => !!u);

    // Sort by most recent message
    usersIChatedWith.sort((a, b) => {
        const timeA = latestMessages[a.uid]?.timestamp || 0;
        const timeB = latestMessages[b.uid]?.timestamp || 0;
        return timeB - timeA;
    });

    if (usersIChatedWith.length === 0 && !botUser) { // Only show this if no chats at all, including bot
        list.innerHTML = '<p class="text-muted" style="text-align: center; margin-top:20px;">No recent chats. Search for a user to start!</p>';
        return;
    }

    usersIChatedWith.forEach(u => {
        const msg = latestMessages[u.uid];
        const preview = msg ? (msg.senderId === myId ? `You: ${msg.text || 'Sent an attachment'}` : msg.text || 'Sent an attachment') : 'Tap to chat';

        const item = document.createElement('div');
        item.className = 'chat-item';
        const userOnlineStatusClass = u.online ? 'online' : '';
        item.innerHTML = `
            <div class="avatar">
                <div class="avatar-container">
                    <img src="${u.avatarUrl}">
                    <div class="status-dot ${userOnlineStatusClass}"></div>
                </div>
            </div>
            <div class="chat-info">
                <h4>${u.displayName} ${u.isVerified ? '<span class="material-symbols-rounded verified-icon" style="font-size: 14px;">verified</span>' : ''}</h4>
                <p style="color:var(--text-muted); font-size:13px;">${preview.substring(0, 30)}${preview.length > 30 ? '...' : ''}</p>
            </div>
        `;
        item.addEventListener('click', () => openChatWithUser(u.uid));
        list.appendChild(item);
    });
}

function formatLastSeen(timestamp) {
    if (!timestamp) return "Offline";
    const diff = (Date.now() - timestamp) / 1000;
    if (diff < 60) return "Last seen just now";

    const mins = Math.floor(diff / 60);
    if (mins < 60) return `Last seen ${mins} minute${mins !== 1 ? 's' : ''} ago`;

    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Last seen ${hours} hour${hours !== 1 ? 's' : ''} ago`;

    const d = new Date(timestamp);
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const yesterday = new Date(Date.now() - 86400000);
    if (d.getDate() === yesterday.getDate() && d.getMonth() === yesterday.getMonth()) {
        return `Last seen yesterday at ${timeStr}`;
    }

    return `Last seen ${d.toLocaleDateString()} at ${timeStr}`;
}

function updateChatHeaderStatus(user) {
    const statusEl = document.getElementById('chat-header-status');
    if (!statusEl) return;

    if (user.online) {
        statusEl.textContent = 'Online';
        statusEl.className = 'chat-status online';
    } else {
        statusEl.textContent = formatLastSeen(user.lastSeen);
        statusEl.className = 'chat-status offline';
    }
}

window.openChatWithUser = function (targetUid) {
    const user = dbState.users.find(u => u.uid === targetUid);
    if (!user) return;

    activeChatUser = user;
    const arr = [currentUser.uid, user.uid].sort();
    activeChatId = `chat_${arr[0]}_${arr[1]}`;

    // Store the target UID on the header element for reliable access on click
    const headerLink = document.getElementById('chat-header-profile-link');
    if (headerLink) headerLink.dataset.targetUid = user.uid;

    document.getElementById('active-chat-name').innerHTML = `${user.displayName} ${user.isVerified ? '<span class="material-symbols-rounded verified-icon" style="font-size:16px;">verified</span>' : ''}`;
    document.getElementById('active-chat-avatar').src = user.avatarUrl;

    updateChatHeaderStatus(user);

    const msgArea = document.getElementById('messages-area');
    msgArea.innerHTML = '<div style="text-align:center; padding: 20px; color:var(--text-muted)">Loading...</div>';

    socket.emit('join_chat', activeChatId);

    // Clear unread badge for this chat instantly
    socket.emit('mark_messages_read', { chatId: activeChatId, uid: currentUser.uid });

    switchScreen('chat');
}

// Chat events
if (socket) socket.on('chat_history', (data) => {
    if (data.chatId === activeChatId) {
        renderMessages(data.messages);
    }
});

function updateUnreadBadge() {
    if (!currentUser) return;
    let unreadCount = 0;

    // Calculate how many unread messages are targeting the current user
    dbState.messages.forEach(msg => {
        // message belongs to chat with current user, is not from current user, and hasn't been read
        const chatUids = msg.chatId.replace('chat_', '').split('_');
        if (chatUids.includes(currentUser.uid) && msg.senderId !== currentUser.uid && !msg.read) {
            unreadCount++;
        }
    });

    const badge = document.getElementById('chat-unread-badge');
    if (badge) {
        if (unreadCount > 0) {
            badge.innerText = unreadCount > 99 ? '99+' : unreadCount;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }
}

if (socket) socket.on('receive_message', (msg) => {
    // Check if message already exists to avoid duplicates (e.g. from history + real-time)
    if (!dbState.messages.find(m => m.id === msg.id)) {
        dbState.messages.push(msg);
    }

    if (msg.chatId === activeChatId) {
        appendMessage(msg);

        // Auto-mark as read since they are in the active chat
        socket.emit('mark_messages_read', { chatId: activeChatId, uid: currentUser.uid });
    }

    // Always refresh chats list if on home screen to show latest message/preview
    if (screens.home.classList.contains('active') && activeHomeTab === 'chats') {
        renderChatsList();
    }

    updateUnreadBadge();

    // Show notification if not in this chat
    if (activeChatId !== msg.chatId) {
        const sender = dbState.users.find(u => u.uid === msg.senderId);
        showToastNotification(`New message from ${sender?.displayName || 'Someone'}`, msg.text || "Sent an attachment", 'chat', msg.senderId, sender?.avatarUrl);
    }
});

if (socket) socket.on('notification', (data) => {
    if (data.type === 'message' && activeChatId) {
        // Prevent showing message toast if they are already in the chat
        // We know the sender is activeChatUser if activeChatId is for them
        const chatUids = activeChatId.replace('chat_', '').split('_');
        if (chatUids.includes(currentUser.uid) && chatUids.includes(activeChatUser?.uid)) {
            // Already looking at the chat, no toast needed
            return;
        }
    }
    showToastNotification(data.title, data.body, data.type, data.sourceId);
});

// --- Toast & Notif Logic ---
function showToastNotification(title, body, type = 'system', sourceId = null, avatarUrl = null) {
    if (Notification.permission === 'granted' && document.hidden) {
        const n = new Notification(title, { body: body, icon: avatarUrl || '/res/logo.png' });
        n.onclick = () => {
            window.focus();
            if (type === 'chat' && sourceId) openChatWithUser(sourceId);
            else if ((type === 'post' || type === 'mention' || type === 'comment') && sourceId) {
                // Determine what sourceId belongs to
                const post = dbState.posts.find(p => p.id === sourceId);
                if (post) openPostComments(post.id);
                else {
                    const comment = dbState.comments.find(c => c.id === sourceId);
                    if (comment) openPostComments(comment.postId);
                }
            }
        };
    }

    // Save to our notification tray array
    dbState.notifications.push({
        id: Date.now(),
        title,
        body,
        type,
        sourceId,
        timestamp: Date.now()
    });

    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = type === 'chat' ? 'toast-message-popup slide-left-anim' : 'glass-panel slide-up-anim';

    if (type !== 'chat') {
        toast.style.padding = '15px';
        toast.style.minWidth = '250px';
        toast.style.borderLeft = '4px solid var(--neon-cyan)';
        toast.style.cursor = 'pointer';
        toast.innerHTML = `
            <h5 style="margin: 0; color: var(--text-main);">${title}</h5>
            <p style="margin: 4px 0 0 0; font-size: 12px; color: var(--text-muted);">${body.length > 50 ? body.substring(0, 50) + '...' : body}</p>
        `;
    } else {
        toast.innerHTML = `
            <img src="${avatarUrl || 'https://i.pravatar.cc/150?u=' + sourceId}" class="toast-avatar" alt="Avatar">
            <div class="toast-content">
                <h5>${title.replace('New message from ', '')}</h5>
                <p>${body}</p>
            </div>
            <span class="material-symbols-rounded" style="color: var(--text-muted); font-size: 18px;" onclick="event.stopPropagation(); this.parentElement.remove();">close</span>
        `;
    }

    toast.onclick = () => {
        if (type === 'chat') {
            openChatWithUser(sourceId);
        } else if (type === 'post' || type === 'comment' || type === 'reply') {
            switchScreen('home');
            switchHomeTab('feed');
            if (sourceId) {
                setTimeout(() => {
                    const el = document.getElementById('post_' + sourceId);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    if (type === 'comment' || type === 'reply') openComments(sourceId);
                }, 300);
            }
        }
        toast.remove();
    };

    container.appendChild(toast);

    // Auto dismiss after 4 seconds
    setTimeout(() => {
        if (toast.parentElement) {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
            if (type === 'chat') toast.style.transform = 'translateX(100%)';
            setTimeout(() => toast.remove(), 400);
        }
    }, 4000);
}

if (socket) socket.on('message_updated', (msg) => {
    if (msg.chatId === activeChatId) {
        const msgEl = document.getElementById(msg.id);
        if (msgEl) {
            let contentHtml = '';
            if (msg.text) contentHtml += `<div>${msg.text} <span style="font-size:10px; opacity:0.5">(edited)</span></div>`;
            if (msg.attachmentHtml) contentHtml += `<div class="msg-attachment">${msg.attachmentHtml}</div>`;
            msgEl.querySelector('.msg-content-wrapper').innerHTML = contentHtml;
        }
    }
});

if (socket) socket.on('message_deleted', (data) => {
    if (data.chatId === activeChatId) {
        const msgEl = document.getElementById(data.msgId);
        if (msgEl) msgEl.remove();
    }
});

if (socket) socket.on('user_typing', (data) => {
    if (data.chatId === activeChatId && data.senderId !== currentUser.uid) {
        const ind = document.getElementById('typing-indicator');
        ind.classList.remove('hidden');
        clearTimeout(ind.timer);
        ind.timer = setTimeout(() => ind.classList.add('hidden'), 2000);
    }
});


document.getElementById('back-to-home').addEventListener('click', () => {
    activeChatId = null;
    switchScreen('home');
});

// Global function so it can be called from inline onclick too
window.openChatHeaderProfile = function () {
    const headerLink = document.getElementById('chat-header-profile-link');
    const targetUid = (headerLink && headerLink.dataset.targetUid) || (activeChatUser && activeChatUser.uid);
    console.log('[Chat Header] Opening profile for UID:', targetUid);
    if (targetUid) {
        openUserProfile(targetUid);
    } else {
        console.warn('[Chat Header] No target UID found — data-targetUid not set yet.');
    }
};

document.getElementById('chat-header-profile-link').addEventListener('click', (e) => {
    window.openChatHeaderProfile();
});
document.getElementById('profile-back-btn').addEventListener('click', () => switchScreen('home'));
document.getElementById('nav-profile-btn').addEventListener('click', () => {
    loadUserProfile();
    switchScreen('profile');
});

const msgInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const msgArea = document.getElementById('messages-area');

function renderMessages(msgs) {
    msgArea.innerHTML = '';
    msgs.forEach(m => appendMessage(m));
}

function appendMessage(msg) {
    const isSent = msg.senderId === currentUser.uid;
    const canDelete = isSent || ROLE_POWER[currentUser.role] >= ROLE_POWER['moderator'];
    const canEdit = isSent;

    const msgDiv = document.createElement('div');
    msgDiv.id = msg.id;
    msgDiv.className = `msg ${isSent ? 'sent' : 'received'}`;

    let contentHtml = '';
    if (msg.text) contentHtml += `<div>${msg.text} ${msg.isEdited ? '<span style="font-size:10px; opacity:0.5">(edited)</span>' : ''}</div>`;
    if (msg.attachmentHtml) contentHtml += `<div class="msg-attachment">${msg.attachmentHtml}</div>`;

    msgDiv.innerHTML = `<div class="msg-content-wrapper">${contentHtml}</div>`;

    let actionsHtml = `<div class="msg-actions">`;
    actionsHtml += `<button onclick="openReportModal('message', '${msg.id}')" title="Report" style="color:var(--danger-red);"><span class="material-symbols-rounded">flag</span></button>`;
    if (canEdit) actionsHtml += `<button onclick="triggerEditMsg('${msg.id}')" title="Edit"><span class="material-symbols-rounded">edit</span></button>`;
    if (canDelete) actionsHtml += `<button onclick="triggerDeleteMsg('${msg.id}')" title="Delete"><span class="material-symbols-rounded">delete</span></button>`;
    actionsHtml += `</div>`;

    if (true) { // Always append actions HTML so users can report
        msgDiv.innerHTML += actionsHtml;
    }

    msgArea.appendChild(msgDiv);
    msgArea.scrollTop = msgArea.scrollHeight;
}

window.triggerEditMsg = function (msgId) {
    const newText = prompt("Edit your message:");
    if (newText !== null && newText.trim() !== "") {
        socket.emit('edit_message', { msgId, newText: newText.trim() }, (res) => {
            if (!res.success) alert("Failed to edit message.");
        });
    }
}

window.triggerDeleteMsg = function (msgId) {
    if (confirm("Delete this message?")) {
        socket.emit('delete_message', { msgId }, (res) => {
            if (!res.success) alert("Failed to delete message.");
        });
    }
}

function sendMessage(attachmentHtml = null) {
    if (currentUser) {
        if (currentUser.isBanned) {
            showToastNotification('Action Blocked', 'You cannot send messages while your account is banned.', 'system');
            return;
        }
        if (currentUser.isBlocked) {
            // Allow messaging the admin who blocked them
            if (activeChatUser && activeChatUser.uid !== currentUser.blockedBy) {
                showToastNotification('Action Blocked', 'You cannot send messages while blocked, except to the Admin who blocked you.', 'system');
                return;
            }
        }
    }
    const text = msgInput.value.trim();
    if ((!text && !attachmentHtml) || !activeChatId) return;

    socket.emit('send_message', {
        chatId: activeChatId,
        text,
        attachmentHtml
    });

    msgInput.value = '';
}

sendBtn.addEventListener('click', () => sendMessage());
msgInput.addEventListener('keypress', (e) => {
    socket.emit('typing', { chatId: activeChatId });
    if (e.key === 'Enter') sendMessage();
});

// Attachments logic
const attachFileBtn = document.getElementById('attach-file-btn');
const chatAttachmentInput = document.getElementById('chat-attachment-input');

attachFileBtn.addEventListener('click', () => chatAttachmentInput.click());

chatAttachmentInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileType = file.type;
    const reader = new FileReader();

    reader.onload = (event) => {
        const fileData = event.target.result;
        let attachmentHtml = '';

        if (fileType.startsWith('image/')) {
            attachmentHtml = `<img src="${fileData}" alt="Image Attachment">`;
        } else if (fileType.startsWith('video/')) {
            attachmentHtml = `<video src="${fileData}" controls></video>`;
        } else {
            attachmentHtml = `
                <a href="${fileData}" download="${file.name}" class="msg-document">
                    <span class="material-symbols-rounded doc-icon">description</span>
                    <span class="doc-name">${file.name}</span>
                </a>
            `;
        }
        sendMessage(attachmentHtml);
    };

    reader.readAsDataURL(file);
    chatAttachmentInput.value = '';
});

// Microphone Voice Recording Logic
const micBtn = document.getElementById('mic-btn');
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

if (micBtn) {
    micBtn.addEventListener('click', async () => {
        if (!isRecording) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                mediaRecorder.start();
                isRecording = true;
                micBtn.style.color = 'var(--danger-red)'; // Indicate recording
                micBtn.querySelector('span').innerText = 'stop_circle';
                audioChunks = [];

                mediaRecorder.addEventListener('dataavailable', event => {
                    audioChunks.push(event.data);
                });

                mediaRecorder.addEventListener('stop', () => {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = () => {
                        const base64Audio = reader.result;
                        const attachmentHtml = `<audio src="${base64Audio}" controls style="width: 200px;"></audio>`;
                        sendMessage(attachmentHtml);
                    };

                    stream.getTracks().forEach(track => track.stop());
                });
            } catch (err) {
                console.error("Microphone access denied or error:", err);
                alert("Microphone access is required to send voice messages.");
            }
        } else {
            mediaRecorder.stop();
            isRecording = false;
            micBtn.style.color = ''; // Reset color
            micBtn.querySelector('span').innerText = 'mic';
        }
    });
}


// Call Logic
const AGORA_APP_ID = '500b5587fae44280bba4b70f1b8a1a0b';
let agoraClient = null;
let localAudioTrack = null;
let localVideoTrack = null;
let activeCallPeerUid = null;
let activeChannelId = null;
let currentCameras = [];
let activeCameraIndex = 0;

async function initAgoraClient() {
    if (!agoraClient) {
        agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
        agoraClient.on("user-published", async (user, mediaType) => {
            await agoraClient.subscribe(user, mediaType);
            if (mediaType === "video") {
                const remoteVideoContainer = document.getElementById("remote-video");
                remoteVideoContainer.classList.remove('hidden');
                const callBgImage = document.getElementById('call-bg-image');
                if (callBgImage) callBgImage.classList.add('hidden');
                const callCenterInfo = document.getElementById('call-center-info');
                if (callCenterInfo) callCenterInfo.style.display = 'none';
                user.videoTrack.play(remoteVideoContainer);
            }
            if (mediaType === "audio") {
                user.audioTrack.play();
            }
        });
        agoraClient.on("user-unpublished", (user, mediaType) => {
            if (mediaType === "video") {
                document.getElementById("remote-video").classList.add('hidden');
                const callBgImage = document.getElementById('call-bg-image');
                if (callBgImage) callBgImage.classList.remove('hidden');
                const callCenterInfo = document.getElementById('call-center-info');
                if (callCenterInfo) callCenterInfo.style.display = 'flex';
            }
        });
    }
}

async function startRealTimeCall(isVideo, isIncoming = false, incomingData = null) {
    let targetName = "Unknown";
    let targetAvatar = "https://i.pravatar.cc/150";

    await initAgoraClient();

    if (!isIncoming && activeChatUser) {
        activeCallPeerUid = activeChatUser.uid;
        activeChannelId = `call_${currentUser.uid}_${activeChatUser.uid}_${Date.now()}`;
        socket.emit('call_user', { targetUid: activeChatUser.uid, isVideo, channelId: activeChannelId });
        showToastNotification('Calling...', `Ringing ${activeChatUser.displayName}`);
        targetName = activeChatUser.displayName;
        targetAvatar = activeChatUser.avatarUrl;
    } else if (isIncoming && incomingData) {
        activeCallPeerUid = incomingData.callerId;
        activeChannelId = incomingData.channelId;
        targetName = incomingData.callerName;
        targetAvatar = incomingData.callerAvatar;
    }

    // Modern Call UI injection
    document.getElementById('call-contact-name').innerText = targetName;
    document.getElementById('call-contact-avatar').src = targetAvatar;
    document.getElementById('call-bg-image').src = targetAvatar;

    const callTypeLabel = document.getElementById('call-type-label');
    if (callTypeLabel) callTypeLabel.innerText = isVideo ? "Video Call" : "Voice Call";
    document.getElementById('call-status-text').innerText = isIncoming ? 'Connecting...' : 'Calling...';

    switchScreen('call');

    isMicMuted = false;
    isVideoMuted = !isVideo;
    document.getElementById('call-mic-btn').innerHTML = '<span class="material-symbols-rounded">mic</span>';
    document.getElementById('call-camera-btn').innerHTML = isVideo ? '<span class="material-symbols-rounded">videocam</span>' : '<span class="material-symbols-rounded">videocam_off</span>';

    try {
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
        const tracksToPublish = [localAudioTrack];

        if (isVideo) {
            localVideoTrack = await AgoraRTC.createCameraVideoTrack();
            const localVideoContainer = document.getElementById('local-video');
            localVideoContainer.classList.remove('hidden');
            document.getElementById('call-bg-image').classList.add('hidden');
            localVideoTrack.play(localVideoContainer);
            tracksToPublish.push(localVideoTrack);

            AgoraRTC.getCameras().then(cameras => {
                currentCameras = cameras;
                activeCameraIndex = 0;
            }).catch(e => console.error(e));
        } else {
            document.getElementById('local-video').classList.add('hidden');
            document.getElementById('call-bg-image').classList.remove('hidden');
        }

        await agoraClient.join(AGORA_APP_ID, activeChannelId, null, currentUser.uid);
        await agoraClient.publish(tracksToPublish);

        if (isIncoming) {
            document.getElementById('call-status-text').innerText = 'Connected';
        }
    } catch (err) {
        console.warn("Media devices error:", err);
        showToastNotification("Camera/Microphone Error", "Could not access media devices.", "system");
    }
}

let activeIncomingCall = null;
let activeCallTimeout = null;

const rtcConfig = {
    mode: "rtc",
    codec: "vp8",
};
const ringtoneAudio = document.getElementById('ringtone-audio');

if (socket) socket.on('incoming_call', (data) => {
    if (data.targetUid === currentUser.uid) {
        activeIncomingCall = data;

        document.getElementById('incoming-caller-name').innerText = data.callerName;
        document.getElementById('incoming-caller-avatar').src = data.callerAvatar;

        const banner = document.getElementById('incoming-call-modal');
        banner.classList.remove('hidden');
        banner.classList.add('slide-down-anim');

        // Play Ringtone
        if (ringtoneAudio) {
            ringtoneAudio.currentTime = 0;
            ringtoneAudio.play().catch(e => console.log("Audio autoplay prevented by browser"));
        }

        // Feature: 30 Second Call Timeout
        if (activeCallTimeout) clearTimeout(activeCallTimeout);
        activeCallTimeout = setTimeout(() => {
            if (activeIncomingCall && activeIncomingCall.channelId === data.channelId) {
                // Call timed out (Missed)
                showToastNotification('Missed Call', `Missed call from @${data.callerName}.`, 'system');

                // Clear UI
                const banner = document.getElementById('incoming-call-modal');
                banner.classList.remove('slide-down-anim');
                banner.classList.add('hidden');

                if (ringtoneAudio) {
                    ringtoneAudio.pause();
                    ringtoneAudio.currentTime = 0;
                }

                // Alert Server so it notifies sender
                socket.emit('call_timeout', { targetUid: data.callerId, channelId: data.channelId, type: 'missed' });
                activeIncomingCall = null;
            }
        }, 30000);
    }
});

if (socket) {
    socket.on('call_accepted_by_user', async (data) => {
        if (activeChatUser && data.targetUid === currentUser.uid) {
            showToastNotification('Call Connected', 'The user answered your call.');
            const statusEl = document.getElementById('call-status-text');
            if (statusEl) statusEl.innerText = 'Connected';

            await createPeerConnection(activeChatUser.uid, true);
        }
    });

    socket.on('call_rejected_by_user', (data) => {
        if (data.targetUid === currentUser.uid) {
            showToastNotification('Call Declined', 'The user declined the call.');
            if (typeof window.endRealTimeCall === 'function') window.endRealTimeCall();
        }
    });
}

if (socket) socket.on('call_ended_by_user', (data) => {
    // If we receive a call_ended_by_user event and the call screen is active, immediately end the call.
    if (document.getElementById('call-screen').classList.contains('active')) {
        showToastNotification('Call Ended', 'The call was disconnected.', 'system');
        endRealTimeCall(false); // pass false so we don't double-emit to server
    } else if (activeIncomingCall && data.targetUid === activeIncomingCall.callerId) {
        // If they hung up while we are still on the "Incoming Call" modal (ringing phase)
        showToastNotification('Missed Call', 'The caller hung up.', 'system');
        const banner = document.getElementById('incoming-call-modal');
        banner.classList.remove('slide-down-anim');
        banner.classList.add('hidden');
        if (ringtoneAudio) {
            ringtoneAudio.pause();
            ringtoneAudio.currentTime = 0;
        }
        if (activeCallTimeout) clearTimeout(activeCallTimeout);
        activeIncomingCall = null;
    }
});

if (socket) socket.on('call_timeout_sender', (data) => {
    // If the receiver didn't answer and the server emits this back to the caller
    if (document.getElementById('call-screen').classList.contains('active')) {
        showToastNotification('No Answer', 'The user did not answer.', 'system');
        endRealTimeCall(false);
    }
});

document.getElementById('btn-accept-call').addEventListener('click', async () => {
    if (activeIncomingCall) {
        if (ringtoneAudio) {
            ringtoneAudio.pause();
            ringtoneAudio.currentTime = 0;
        }
        const banner = document.getElementById('incoming-call-modal');
        banner.classList.remove('slide-down-anim');
        banner.classList.add('hidden');

        await startRealTimeCall(activeIncomingCall.isVideo, true, activeIncomingCall);

        socket.emit('call_accepted', { targetUid: activeIncomingCall.callerId, channelId: activeIncomingCall.channelId });

        if (activeCallTimeout) clearTimeout(activeCallTimeout);
        activeIncomingCall = null;
    }
});

document.getElementById('btn-decline-call').addEventListener('click', () => {
    if (activeIncomingCall) {
        socket.emit('call_rejected', { targetUid: activeIncomingCall.callerId });

        if (ringtoneAudio) {
            ringtoneAudio.pause();
            ringtoneAudio.currentTime = 0;
        }
        const banner = document.getElementById('incoming-call-modal');
        banner.classList.remove('slide-down-anim');
        banner.classList.add('hidden');

        if (activeCallTimeout) clearTimeout(activeCallTimeout);
        activeIncomingCall = null;
    }
});

document.getElementById('start-video-call-btn') ? document.getElementById('start-video-call-btn').addEventListener('click', () => startRealTimeCall(true)) : null;
document.getElementById('start-call-btn').addEventListener('click', () => startRealTimeCall(true));
if (document.getElementById('start-voice-call-btn')) {
    document.getElementById('start-voice-call-btn').addEventListener('click', () => startRealTimeCall(false));
}

function addTouchClickListener(element, callback) {
    if (!element) return;
    element.addEventListener('click', callback);
    element.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        callback(e);
    }, { passive: false });
}

addTouchClickListener(document.getElementById('end-call-btn'), () => { if (typeof window.endRealTimeCall === 'function') window.endRealTimeCall(); });
addTouchClickListener(document.getElementById('end-call-top'), () => { if (typeof window.endRealTimeCall === 'function') window.endRealTimeCall(); });

// Call Controls Logic
const callControlsContainer = document.querySelector('.call-controls');
if (callControlsContainer) {
    callControlsContainer.addEventListener('touchmove', (e) => {
        e.preventDefault();
    }, { passive: false });
}

let isMicMuted = false;
let isVideoMuted = false;
let isSpeakerOn = false;

addTouchClickListener(document.getElementById('call-mic-btn'), () => {
    isMicMuted = !isMicMuted;
    document.getElementById('call-mic-btn').innerHTML = isMicMuted ? '<span class="material-symbols-rounded">mic_off</span>' : '<span class="material-symbols-rounded">mic</span>';
    if (localAudioTrack) {
        localAudioTrack.setEnabled(!isMicMuted);
    }
});

addTouchClickListener(document.getElementById('call-camera-btn'), () => {
    isVideoMuted = !isVideoMuted;
    document.getElementById('call-camera-btn').innerHTML = isVideoMuted ? '<span class="material-symbols-rounded">videocam_off</span>' : '<span class="material-symbols-rounded">videocam</span>';
    if (localVideoTrack) {
        localVideoTrack.setEnabled(!isVideoMuted);
        const localVideoContainer = document.getElementById('local-video');
        if (isVideoMuted) {
            localVideoContainer.classList.add('hidden');
        } else {
            localVideoContainer.classList.remove('hidden');
        }
    }
});

addTouchClickListener(document.getElementById('call-camera-switch-btn'), async () => {
    if (localVideoTrack && currentCameras.length > 1) {
        activeCameraIndex = (activeCameraIndex + 1) % currentCameras.length;
        try {
            await localVideoTrack.setDevice(currentCameras[activeCameraIndex].deviceId);
        } catch (e) {
            console.error("Error switching camera", e);
        }
    }
});

const speakerBtn = document.getElementById('call-speaker-btn');
addTouchClickListener(speakerBtn, () => {
    isSpeakerOn = !isSpeakerOn;
    if (speakerBtn) {
        speakerBtn.innerHTML = isSpeakerOn ? '<span class="material-symbols-rounded">volume_up</span>' : '<span class="material-symbols-rounded">volume_off</span>';
    }
    // Note: Full speaker abstraction on web requires AudioContext routing, using UI toggle to simulate for now
});

const effectsBtn = document.querySelector('.effects-btn');
const auraBorder = document.querySelector('.aura-cast-border');
let effectsOn = true;
if (effectsBtn) {
    effectsBtn.addEventListener('click', () => {
        effectsOn = !effectsOn;
        if (auraBorder) auraBorder.style.display = effectsOn ? 'block' : 'none';
        effectsBtn.style.color = effectsOn ? 'var(--text-main)' : 'var(--text-muted)';
    });
}

window.endRealTimeCall = async function (shouldEmit = true) {
    if (localAudioTrack) {
        localAudioTrack.close();
        localAudioTrack = null;
    }
    if (localVideoTrack) {
        localVideoTrack.close();
        localVideoTrack = null;
    }
    if (agoraClient) {
        try {
            await agoraClient.leave();
        } catch (e) { }
    }

    const remoteVideo = document.getElementById('remote-video');
    if (remoteVideo) {
        remoteVideo.innerHTML = '';
        remoteVideo.classList.add('hidden');
        remoteVideo.style.opacity = '1';
    }

    const localVideo = document.getElementById('local-video');
    if (localVideo) {
        localVideo.innerHTML = '';
        localVideo.classList.add('hidden');
    }

    const callCenterInfo = document.getElementById('call-center-info');
    if (callCenterInfo) callCenterInfo.style.display = 'flex';
    const callBgImage = document.getElementById('call-bg-image');
    if (callBgImage) callBgImage.classList.remove('hidden');

    if (shouldEmit) {
        if (activeCallPeerUid) {
            socket.emit('call_ended', { targetUid: activeCallPeerUid });
        } else if (activeChatUser) {
            socket.emit('call_ended', { targetUid: activeChatUser.uid });
        } else if (activeIncomingCall) {
            socket.emit('call_ended', { targetUid: activeIncomingCall.callerId });
        }
    }

    document.getElementById('call-screen').classList.remove('active');
    const banner = document.getElementById('incoming-call-modal');
    if (banner) {
        banner.classList.remove('slide-down-anim');
        banner.classList.add('hidden');
    }
    if (ringtoneAudio) {
        ringtoneAudio.pause();
        ringtoneAudio.currentTime = 0;
    }
    activeIncomingCall = null;
    activeCallPeerUid = null; // Clear the active peer
    activeChannelId = null;

    if (activeChatId) {
        switchScreen('chat');
    } else {
        switchScreen('home');
    }
}
