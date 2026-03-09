const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Increase max upload size to 100MB

const ROLE_POWER = {
    owner: 4,
    admin: 3,
    moderator: 2,
    user: 1,
    bot: 1
};

function hasPermission(actorRole, targetRole) {
    return (ROLE_POWER[actorRole] || 1) > (ROLE_POWER[targetRole] || 1);
}

// Serve static files
app.use(express.static(path.join(__dirname, '.')));

// Firebase Initialization
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, set, get } = require("firebase/database");

const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const firebaseApp = initializeApp(firebaseConfig);
const firebaseDb = getDatabase(firebaseApp);

// Centralized Database (Local Cache)
let db = {
    users: [
        {
            uid: 'sys_bot',
            email: 'bot@whistachat.com',
            username: 'whista_bot',
            displayName: 'Whistachat.AI',
            role: 'bot',
            isVerified: true,
            avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?q=80&w=200&h=200&fit=crop'
        }
    ],
    verification_requests: [],
    posts: [
        {
            id: 'p1',
            uid: 'sys1',
            username: 'neon.admin',
            avatarUrl: 'https://i.pravatar.cc/100?img=12',
            caption: 'Welcome to the new Real-Time Social Feed! 🚀',
            mediaUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=600&h=400&fit=crop',
            likes: ['sys1'],
            createdAt: Date.now()
        }
    ],
    comments: [],
    messages: [], // Format: { id, chatId, senderId, text, attachmentHtml, timestamp, isEdited }
    action_logs: [],
    reports: []
};

// Fetch initial state from Firebase RTDB
get(ref(firebaseDb, 'whistachat_db')).then((snapshot) => {
    if (snapshot.exists()) {
        db = snapshot.val();
        // Ensure all arrays exist
        if (!db.users) db.users = [];
        if (!db.verification_requests) db.verification_requests = [];
        if (!db.posts) db.posts = [];
        if (!db.comments) db.comments = [];
        if (!db.messages) db.messages = [];
        if (!db.action_logs) db.action_logs = [];
        if (!db.reports) db.reports = [];
        console.log("Database successfully synced from Firebase RTDB.");
    } else {
        // First boot: push default layout structure up
        set(ref(firebaseDb, 'whistachat_db'), db).then(() => {
            console.log("Initial default database deployed to Firebase.");
        });
    }
}).catch((error) => {
    console.error("Error fetching from Firebase:", error);
});

function saveDB() {
    set(ref(firebaseDb, 'whistachat_db'), db).catch(err => console.error("Firebase Sync Error:", err));
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('login', (data, callback) => {
        const { email, pass } = data;
        let user = db.users.find(u => u.email === email && u.password === pass);
        if (user) {
            if (user.isBanned) {
                if (user.bannedUntil && Date.now() > user.bannedUntil) {
                    user.isBanned = false;
                    user.bannedUntil = null;
                } else {
                    return callback({ success: false, message: 'This account has been banned by an administrator.' });
                }
            }
            user.status = 'online';
            user.online = true;
            user.lastSeen = Date.now();
            user.socketId = socket.id;
            socket.uid = user.uid;
            socket.join(user.uid); // Join personal room for notifications
            saveDB(); // Broadcast to Firebase instantly
            callback({ success: true, user: user, dbState: getPublicDbState() });
            io.emit('users_update', db.users);
        } else {
            callback({ success: false, message: 'Invalid credentials' });
        }
    });

    socket.on('signup', (data, callback) => {
        const { email, pass } = data;
        if (db.users.some(u => u.email === email)) {
            callback({ success: false, message: "Email already exists" });
            return;
        }

        const ownerEmails = process.env.OWNER_EMAILS ? process.env.OWNER_EMAILS.split(',').map(e => e.trim()) : [];
        const isOwner = ownerEmails.includes(email);

        const newUser = {
            email,
            password: pass,
            role: isOwner ? 'owner' : 'user',
            isVerified: isOwner,
            uid: 'u_' + Date.now(),
            username: '', // Default to empty string to prevent @undefined
            avatarUrl: `https://i.pravatar.cc/100?u=${Date.now()}`,
            bio: '',
            location: '',
            contactNumber: '',
            followers: [],
            following: [],
            isBlocked: false,
            blockedBy: null,
            blockedUntil: null,
            isBanned: false,
            bannedUntil: null
        };
        db.users.push(newUser);
        saveDB();
        socket.uid = newUser.uid;
        socket.join(newUser.uid);
        callback({ success: true, user: newUser, dbState: getPublicDbState() });
    });

    socket.on('complete_setup', (data, callback) => {
        const { username } = data;
        const user = db.users.find(u => u.uid === socket.uid);
        if (!user) return callback({ success: false });

        if (db.users.some(u => u.username === username && u.uid !== socket.uid)) {
            callback({ success: false, message: "Username taken" });
        } else {
            user.username = username;
            user.displayName = username;
            saveDB();
            io.emit('db_update', { users: db.users });
            callback({ success: true, user, dbState: getPublicDbState() });
        }
    });

    socket.on('request_db_state', (callback) => {
        if (callback) callback(getPublicDbState());
    });

    socket.on('search_users', (query, callback) => {
        const lowerQ = query.toLowerCase();
        const results = db.users.filter(u =>
            u.uid !== socket.uid &&
            (u.username?.toLowerCase().includes(lowerQ) || u.displayName?.toLowerCase().includes(lowerQ))
        );
        callback(results);
    });

    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
        const chatHistory = db.messages.filter(m => m.chatId === chatId);
        socket.emit('chat_history', { chatId, messages: chatHistory });
    });

    socket.on('send_message', (data) => {
        const user = db.users.find(u => u.uid === socket.uid);
        const { chatId, text, attachmentHtml } = data;
        let targetUid = chatId.replace('chat_', '').replace(socket.uid, '');
        if (targetUid.startsWith('_')) targetUid = targetUid.substring(1);
        if (targetUid.endsWith('_')) targetUid = targetUid.substring(0, targetUid.length - 1);

        if (user) {
            if (user.isBanned && user.bannedUntil && Date.now() > user.bannedUntil) {
                user.isBanned = false;
                user.bannedUntil = null;
                saveDB();
            }
            if (user.isBanned && targetUid !== user.bannedBy) return;
            if (user.isBlocked && !user.isBanned && targetUid !== user.blockedBy) return; // Blocked users cannot send messages except to the admin who blocked them
        }

        const message = {
            id: 'm_' + Date.now() + Math.random().toString(36).substr(2, 5),
            chatId,
            senderId: socket.uid,
            text,
            attachmentHtml,
            timestamp: Date.now(),
            isEdited: false
        };
        db.messages.push(message);
        saveDB();

        io.to(chatId).emit('receive_message', message);

        // Notify the receiver
        if (targetUid) {
            const sender = db.users.find(u => u.uid === socket.uid);
            io.to(targetUid).emit('notification', {
                title: `New message from ${sender ? sender.displayName : 'Someone'}`,
                body: text || "Sent an attachment",
                type: 'message'
            });
        }

        if (chatId.includes('sys_bot')) {
            setTimeout(() => {
                handleBotResponse(chatId, text);
            }, 1000);
        }
    });

    socket.on('edit_message', (data, callback) => {
        const { msgId, newText } = data;
        const msg = db.messages.find(m => m.id === msgId);
        if (!msg) return callback({ success: false });

        const user = db.users.find(u => u.uid === socket.uid);
        if (msg.senderId !== socket.uid && (!user || (ROLE_POWER[user.role] < ROLE_POWER['moderator']))) {
            return callback({ success: false, message: "No permission" });
        }

        msg.text = newText;
        msg.isEdited = true;

        io.to(msg.chatId).emit('message_updated', msg);
        callback({ success: true });
    });

    socket.on('delete_message', (data, callback) => {
        const { msgId } = data;
        const msgIndex = db.messages.findIndex(m => m.id === msgId);
        if (msgIndex === -1) return callback({ success: false });

        const msg = db.messages[msgIndex];
        const user = db.users.find(u => u.uid === socket.uid);

        if (msg.senderId === socket.uid || (user && ROLE_POWER[user.role] >= ROLE_POWER['moderator'])) {
            db.messages.splice(msgIndex, 1);
            io.to(msg.chatId).emit('message_deleted', { msgId, chatId: msg.chatId });
            callback({ success: true });
        } else {
            callback({ success: false });
        }
    });

    socket.on('typing', (data) => {
        socket.to(data.chatId).emit('user_typing', { senderId: socket.uid, chatId: data.chatId });
    });

    socket.on('create_post', (post) => {
        const currentUser = db.users.find(u => u.uid === socket.uid);
        if (currentUser) {
            if (currentUser.isBanned && currentUser.bannedUntil && Date.now() > currentUser.bannedUntil) {
                currentUser.isBanned = false;
                currentUser.bannedUntil = null;
                saveDB();
            }
            if (currentUser.isBanned || currentUser.isBlocked) return;
        }

        db.posts.unshift(post);
        saveDB();
        io.emit('db_update', { posts: db.posts });

        if (currentUser && currentUser.followers) {
            currentUser.followers.forEach(followerId => {
                io.to(followerId).emit('notification', {
                    title: `New Post from ${currentUser.displayName}`,
                    body: post.caption || 'Added a new post.',
                    type: 'post',
                    sourceId: post.id
                });
            });
        }
        if (currentUser) notifyMentions(post.caption, currentUser, 'post', post.id);
    });

    socket.on('delete_post', (postId) => {
        const u = db.users.find(user => user.uid === socket.uid);
        if (u && u.isBlocked) return;

        db.posts = db.posts.filter(p => p.id !== postId);
        saveDB();
        io.emit('db_update', { posts: db.posts });
    });

    socket.on('toggle_like', (data) => {
        const u = db.users.find(user => user.uid === socket.uid);
        if (u) {
            if (u.isBanned && u.bannedUntil && Date.now() > u.bannedUntil) {
                u.isBanned = false;
                u.bannedUntil = null;
                saveDB();
            }
            if (u.isBanned || u.isBlocked) return;
        }

        const { postId, uid } = data;
        const post = db.posts.find(p => p.id === postId);
        if (post) {
            const idx = post.likes.indexOf(uid);
            if (idx > -1) post.likes.splice(idx, 1);
            else {
                post.likes.push(uid);
                // Notify post author if liked by someone else
                if (post.uid !== uid) {
                    const liker = db.users.find(u => u.uid === uid);
                    io.to(post.uid).emit('notification', {
                        title: 'New Like',
                        body: `${liker ? liker.displayName : 'Someone'} liked your post.`,
                        type: 'like'
                    });
                }
            }
            saveDB();
            io.emit('db_update', { posts: db.posts });
        }
    });

    socket.on('add_comment', (comment) => {
        const currentUser = db.users.find(u => u.uid === socket.uid);
        if (currentUser) {
            if (currentUser.isBanned && currentUser.bannedUntil && Date.now() > currentUser.bannedUntil) {
                currentUser.isBanned = false;
                currentUser.bannedUntil = null;
                saveDB();
            }
            if (currentUser.isBanned || currentUser.isBlocked) return;
        }

        db.comments.push(comment);
        saveDB();
        io.emit('db_update', { comments: db.comments });

        const commenter = db.users.find(u => u.uid === comment.uid);
        const post = db.posts.find(p => p.id === comment.postId);

        if (comment.replyToId) {
            const parentComment = db.comments.find(c => c.id === comment.replyToId);
            if (parentComment && parentComment.uid !== comment.uid) {
                io.to(parentComment.uid).emit('notification', {
                    title: 'New Reply',
                    body: `${commenter ? commenter.displayName : 'Someone'} replied to your comment.`,
                    type: 'reply',
                    sourceId: post.id
                });
            }
        } else if (post && post.uid !== comment.uid) {
            io.to(post.uid).emit('notification', {
                title: 'New Comment',
                body: `${commenter ? commenter.displayName : 'Someone'} commented: ${comment.text.substring(0, 30)}`,
                type: 'comment',
                sourceId: post.id
            });
        }

        if (commenter) notifyMentions(comment.text, commenter, 'comment', post.id);
    });

    socket.on('toggle_comment_like', (data) => {
        const u = db.users.find(user => user.uid === socket.uid);
        if (u) {
            if (u.isBanned && u.bannedUntil && Date.now() > u.bannedUntil) {
                u.isBanned = false;
                u.bannedUntil = null;
                saveDB();
            }
            if (u.isBanned || u.isBlocked) return;
        }

        const { commentId, uid } = data;
        const comment = db.comments.find(c => c.id === commentId);

        if (comment) {
            comment.likes = comment.likes || [];
            const idx = comment.likes.indexOf(uid);

            if (idx > -1) {
                comment.likes.splice(idx, 1);
            } else {
                comment.likes.push(uid);

                // Notify the comment author
                if (comment.uid !== uid) {
                    const liker = db.users.find(usr => usr.uid === uid);
                    io.to(comment.uid).emit('notification', {
                        title: 'New Like on Comment',
                        body: `${liker ? liker.displayName : 'Someone'} liked your comment.`,
                        type: 'like'
                    });
                }
            }
            saveDB();
            io.emit('db_update', { comments: db.comments });
        }
    });

    socket.on('delete_comment', (commentId) => {
        const u = db.users.find(user => user.uid === socket.uid);
        if (u && u.isBlocked) return;

        db.comments = db.comments.filter(c => c.id !== commentId);
        saveDB();
        io.emit('db_update', { comments: db.comments });
    });

    socket.on('edit_comment', (data) => {
        const u = db.users.find(user => user.uid === socket.uid);
        if (u && u.isBlocked) return;

        const { id, text } = data;
        const c = db.comments.find(c => c.id === id);
        if (c) {
            c.text = text;
            c.isEdited = true;
            saveDB();
            io.emit('db_update', { comments: db.comments });
        }
    });

    socket.on('update_profile', (data, callback) => {
        const currentUser = db.users.find(u => u.uid === socket.uid);
        if (currentUser) {
            if (data.username !== undefined && data.username !== currentUser.username) {
                if (db.users.some(u => u.username === data.username && u.uid !== socket.uid)) {
                    if (callback) callback({ success: false, message: "Username taken" });
                    return;
                }
                currentUser.username = data.username;
                currentUser.displayName = data.username;
            }
            if (data.avatarUrl !== undefined) currentUser.avatarUrl = data.avatarUrl;
            if (data.bio !== undefined) currentUser.bio = data.bio;
            if (data.about !== undefined) currentUser.about = data.about; // Added About section fix
            if (data.location !== undefined) currentUser.location = data.location;
            if (data.contactNumber !== undefined) currentUser.contactNumber = data.contactNumber;

            db.posts.forEach(p => { if (p.uid === currentUser.uid) { p.avatarUrl = currentUser.avatarUrl; p.username = currentUser.username; } });
            db.comments.forEach(c => { if (c.uid === currentUser.uid) { c.avatarUrl = currentUser.avatarUrl; c.username = currentUser.username; } });

            saveDB();
            io.emit('db_update', { users: db.users, posts: db.posts, comments: db.comments });
            if (callback) callback({ success: true, user: currentUser });
        } else {
            if (callback) callback({ success: false });
        }
    });

    socket.on('toggle_follow', (data) => {
        const { targetUid } = data;
        const currentUser = db.users.find(u => u.uid === socket.uid);
        const targetUser = db.users.find(u => u.uid === targetUid);

        if (currentUser && targetUser && currentUser.uid !== targetUser.uid) {
            const isFollowing = currentUser.following.includes(targetUid);
            if (isFollowing) {
                currentUser.following = currentUser.following.filter(id => id !== targetUid);
                targetUser.followers = targetUser.followers.filter(id => id !== currentUser.uid);
            } else {
                currentUser.following.push(targetUid);
                targetUser.followers.push(currentUser.uid);
            }
            io.emit('db_update', { users: db.users });
        }
    });

    socket.on('request_verification', () => {
        const currentUser = db.users.find(u => u.uid === socket.uid);
        if (currentUser && !currentUser.isVerified) {
            // Remove any existing requests for this user to avoid duplicates
            db.verification_requests = db.verification_requests.filter(r => r.uid !== currentUser.uid);
            db.verification_requests.push({
                uid: currentUser.uid,
                username: currentUser.username,
                avatar: currentUser.avatarUrl,
                status: 'pending'
            });
            saveDB();
            io.emit('db_update', { verification_requests: db.verification_requests });
        }
    });

    socket.on('handle_verification', (data, callback) => {
        const { uid, isApproved, action } = data; // action can be 'approve' or 'reject'
        const user = db.users.find(u => u.uid === uid);

        // Find specifically the pending request
        const req = db.verification_requests.find(r => r.uid === uid && r.status === 'pending');

        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (adminUser && ROLE_POWER[adminUser.role] >= ROLE_POWER['admin'] && user && req) {
            if (action === 'approve') {
                req.status = 'approved';
                user.isVerified = true;

                // Remove all other requests for this user just in case
                db.verification_requests = db.verification_requests.filter(r => r.uid !== uid || r === req);

            } else if (action === 'reject') {
                req.status = 'rejected';
                user.isVerified = false;
            }

            db.moderation_logs = db.moderation_logs || [];
            db.moderation_logs.push({
                action: action === 'approve' ? 'verify_user' : 'reject_verification',
                actor: adminUser.uid,
                target: user.uid,
                timestamp: Date.now()
            });

            saveDB();
            io.emit('db_update', { users: db.users, verification_requests: db.verification_requests });
            if (callback) callback({ success: true });
        } else {
            if (callback) callback({ success: false, message: "Action failed. This user request might have already been processed, or your session may have expired. Please refresh the page." });
        }
    });
    // Emit updated verification list after any action
    io.emit('db_update', { users: db.users, verification_requests: db.verification_requests });
    socket.on('change_user_role', (data, callback) => {
        const { targetUid, newRole } = data;
        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (adminUser) {
            const targetUser = db.users.find(u => u.uid === targetUid);
            if (targetUser && hasPermission(adminUser.role, targetUser.role) && hasPermission(adminUser.role, newRole)) {
                targetUser.role = newRole;
                db.moderation_logs = db.moderation_logs || [];
                db.moderation_logs.push({
                    action: "role_change",
                    actor: adminUser.uid,
                    target: targetUser.uid,
                    newRole: newRole,
                    timestamp: Date.now()
                });
                saveDB();
                io.emit('db_update', { users: db.users });
                if (callback) callback({ success: true });
                return;
            }
        }
        if (callback) callback({ success: false });
    });

    socket.on('admin_update_bot_avatar', (data, callback) => {
        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (adminUser && ROLE_POWER[adminUser.role] >= ROLE_POWER['admin']) {
            const botUser = db.users.find(u => u.uid === 'sys_bot');
            if (botUser && data.avatarUrl) {
                botUser.avatarUrl = data.avatarUrl;
                saveDB();
                io.emit('db_update', { users: db.users });
                callback({ success: true });
                return;
            }
        }
        callback({ success: false });
    });

    socket.on('admin_user_search', (query, callback) => {
        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (!adminUser || ROLE_POWER[adminUser.role] < ROLE_POWER['moderator']) {
            return callback([]);
        }
        const lowerQ = query.toLowerCase();
        const results = db.users.filter(u =>
            u.uid !== 'sys_bot' &&
            (u.username?.toLowerCase().includes(lowerQ) || u.displayName?.toLowerCase().includes(lowerQ) || u.email?.toLowerCase().includes(lowerQ))
        );
        callback(results);
    });

    socket.on('admin_action_user', (data, callback) => {
        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (!adminUser || ROLE_POWER[adminUser.role] < ROLE_POWER['moderator']) {
            return callback({ success: false, message: 'Unauthorized' });
        }

        const { targetUid, action } = data;
        const targetUserIndex = db.users.findIndex(u => u.uid === targetUid);
        if (targetUserIndex === -1) {
            return callback({ success: false, message: 'User not found' });
        }

        const targetUser = db.users[targetUserIndex];

        if (targetUser.uid === 'sys_bot') {
            return callback({ success: false, message: 'Cannot perform this action on this user.' });
        }
        if (!hasPermission(adminUser.role, targetUser.role)) {
            return callback({ success: false, message: 'Hierarchy violation: You do not have permission to moderate this user.' });
        }

        const logAction = (actionType, additionalData = {}) => {
            db.moderation_logs = db.moderation_logs || [];
            db.moderation_logs.push({
                action: actionType,
                actor: adminUser.uid,
                target: targetUser.uid,
                timestamp: Date.now(),
                ...additionalData
            });
            db.action_logs = db.action_logs || [];
            db.action_logs.push({
                logId: 'log_' + Date.now() + Math.random().toString(36).substr(2, 5),
                adminId: adminUser.uid,
                adminName: adminUser.username,
                targetUid: targetUser.uid,
                targetName: targetUser.username,
                actionType: actionType,
                timestamp: Date.now()
            });
        };

        switch (action) {
            case 'warn':
                io.to(targetUser.uid).emit('notification', {
                    title: '⚠️ Official Warning',
                    body: `You have violated Whistachat community guidelines. Continued violations may result in account suspension.`,
                    type: 'system',
                    sourceId: adminUser.uid
                });
                logAction('Warn');
                break;
            case 'delete':
                db.users.splice(targetUserIndex, 1);
                db.posts = db.posts.filter(p => p.uid !== targetUid);
                db.comments = db.comments.filter(c => c.uid !== targetUid);
                // Also optionally clean up messages/likes if requested, but basic user wipe solves immediate issues
                logAction('Delete');
                break;
            case 'ban': // Expects data.durationMs if temporary
                targetUser.isBanned = true;
                targetUser.isBlocked = true; // Banned implicitly blocks
                targetUser.bannedBy = adminUser.uid;
                targetUser.bannedReason = data.reason || 'No reason provided';
                if (data.durationMs) {
                    targetUser.bannedUntil = Date.now() + data.durationMs;
                } else {
                    targetUser.bannedUntil = null; // Permanent
                }
                io.to(targetUser.uid).emit('notification', {
                    title: 'Account Banned ⚖️',
                    body: `Your account has been banned. Reason: ${targetUser.bannedReason}. Contact Admin: @${adminUser.username}`,
                    type: 'profile',
                    sourceId: adminUser.uid
                });
                logAction(data.durationMs ? 'Temporary Ban' : 'Permanent Ban');
                break;
            case 'unban':
                targetUser.isBanned = false;
                targetUser.bannedUntil = null;
                logAction('Unban');
                break;
            case 'block':
                targetUser.isBlocked = true;
                targetUser.blockedBy = adminUser.uid;
                targetUser.blockedUntil = Date.now() + (3 * 24 * 60 * 60 * 1000); // 3 days
                io.to(targetUser.uid).emit('notification', {
                    title: 'Account Blocked',
                    body: `You have violated the platform rules. An admin has blocked your account for 3 days. Contact: @${adminUser.username}`,
                    type: 'system',
                    sourceId: adminUser.uid
                });
                logAction('Block');
                break;
            case 'unblock':
                targetUser.isBlocked = false;
                targetUser.blockedBy = null;
                targetUser.blockedUntil = null;
                logAction('Unblock');
                break;
            case 'unverify':
                targetUser.isVerified = false;
                logAction('Unverify');
                break;
            default:
                return callback({ success: false, message: 'Invalid action' });
        }

        saveDB();
        io.emit('db_update', { users: db.users, posts: db.posts, comments: db.comments });
        // Force disconnect banned user if online
        if (action === 'delete' || action === 'ban') {
            const sockets = io.sockets.sockets;
            for (const [id, s] of sockets) {
                if (s.uid === targetUid) {
                    s.disconnect();
                }
            }
        }
        callback({ success: true });
    });

    socket.on('call_user', (data) => {
        const { targetUid, isVideo, channelId } = data;
        const caller = db.users.find(u => u.uid === socket.uid);
        if (caller && targetUid) {
            if (targetUid === 'sys_bot') {
                // Auto-answer for the AI bot
                setTimeout(() => {
                    io.to(socket.uid).emit('call_accepted_by_user', { targetUid: 'sys_bot', channelId });
                    // Provide a voice notification via standard chat to simulate AI connection
                    handleBotResponse(`chat_${socket.uid}_sys_bot`, "I have connected to the call! I cannot speak yet, but I'm here.");
                }, 1500); // Wait 1.5s to simulate ringing
            } else {
                io.to(targetUid).emit('incoming_call', {
                    callerId: caller.uid,
                    callerName: caller.displayName,
                    callerAvatar: caller.avatarUrl,
                    targetUid,
                    isVideo,
                    channelId
                });

                // Send quick notification as well
                io.to(targetUid).emit('notification', {
                    title: 'Incoming Call',
                    body: `${caller.displayName} is calling you.`,
                    type: 'call'
                });
            }
        }
    });

    socket.on('report_content', (data, callback) => {
        const reporter = db.users.find(u => u.uid === socket.uid);
        if (!reporter) return callback({ success: false });

        const { targetType, targetId, reason } = data;

        db.reports = db.reports || [];
        db.reports.push({
            reportId: 'rep_' + Date.now() + Math.random().toString(36).substr(2, 5),
            reporterUid: reporter.uid,
            reporterName: reporter.username,
            targetType,
            targetId,
            reason,
            timestamp: Date.now(),
            status: 'open'
        });

        saveDB();
        io.emit('db_update', { reports: db.reports }); // Allow admins to get live notification updates
        if (callback) callback({ success: true });
    });

    socket.on('admin_resolve_report', (data, callback) => {
        const adminUser = db.users.find(u => u.uid === socket.uid);
        if (!adminUser || adminUser.role !== 'admin') {
            return callback({ success: false });
        }

        const { reportId, status } = data; // status e.g. "resolved", "dismissed"
        const report = db.reports.find(r => r.reportId === reportId);
        if (report) {
            report.status = status;
            saveDB();
            io.emit('db_update', { reports: db.reports });
            return callback({ success: true });
        }
        callback({ success: false });
    });

    socket.on('call_accepted', (data) => {
        if (data.targetUid) {
            io.to(data.targetUid).emit('call_accepted_by_user', { targetUid: socket.uid, channelId: data.channelId });
        }
    });

    socket.on('call_rejected', (data) => {
        if (data.targetUid) {
            io.to(data.targetUid).emit('call_rejected_by_user', { targetUid: socket.uid });
        }
    });

    socket.on('call_ended', (data) => {
        if (data.targetUid) {
            io.to(data.targetUid).emit('call_ended_by_user', { targetUid: socket.uid, callerId: socket.uid });
        }
    });

    socket.on('call_timeout', (data) => {
        if (data.targetUid) {
            io.to(data.targetUid).emit('call_timeout_sender', { targetUid: socket.uid });
        }
    });

    // WebRTC Signaling replaced natively by Agora Cloud Routing

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        if (socket.uid) {
            let u = db.users.find(user => user.uid === socket.uid);
            if (u) {
                u.online = false;
                u.lastSeen = Date.now();
                saveDB();
                io.emit('users_update', db.users);
            }
        }
    });
});

function getPublicDbState() {
    return {
        users: db.users,
        posts: db.posts,
        comments: db.comments,
        messages: db.messages, // Include messages for persistence
        verification_requests: db.verification_requests,
        action_logs: db.action_logs || [],
        reports: db.reports || []
    };
}

async function handleBotResponse(chatId, text) {
    const lowerText = text.toLowerCase().trim();

    // === Hardcoded Personality Responses ===
    const personalityTriggers = [
        { match: ['tumhe kisne banaya', 'aapko kisne banaya', 'who made you', 'who created you', 'kisne banaya'], reply: "Mujhe Sana & Kiran ne banaya hai! 🤖✨ Main Whistachat.AI hoon, tumhara smart dost!" },
        { match: ['aap kaun ho', 'tum kaun ho', 'who are you', 'apna naam batao', 'what is your name'], reply: "Main Whistachat.AI hoon 🤖 — tumhara intelligent assistant! Koi bhi sawaal pucho, main hamesha ready hoon! 💪" },
        { match: ['hello', 'hi', 'hey', 'hii', 'helo', 'namaste', 'namaskar', 'sup', 'yo'], reply: "Hey! 👋 Main Whistachat.AI hoon! Batao, kya help chahiye? English, Hindi ya Hinglish — jisme bhi comfortable ho! 😊" },
    ];

    for (const trigger of personalityTriggers) {
        if (trigger.match.some(t => lowerText.includes(t))) {
            const botMsg = {
                id: 'm_' + Date.now() + Math.random().toString(36).substr(2, 5),
                chatId,
                senderId: 'sys_bot',
                text: trigger.reply,
                attachmentHtml: null,
                timestamp: Date.now(),
                isEdited: false
            };
            db.messages.push(botMsg);
            io.to(chatId).emit('receive_message', botMsg);
            return;
        }
    }

    // === Build conversation history for context ===
    const chatHistory = db.messages
        .filter(m => m.chatId === chatId && m.text)
        .slice(-12) // last 12 messages for context window
        .map(m => ({
            role: m.senderId === 'sys_bot' ? 'model' : 'user',
            parts: [{ text: m.text }]
        }));

    // Remove the last user message since we pass it separately
    if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'user') {
        chatHistory.pop();
    }

    const SYSTEM_PROMPT = `You are Whistachat.AI — a smart, friendly, and highly capable AI assistant built into the Whistachat social app. Think of yourself as a personal AI bestie.

PERSONALITY:
- Respond naturally and conversationally, like a smart friend — not a formal robot.
- Be helpful, accurate, concise and warm. Add emojis occasionally for a fun touch.
- Never say you cannot do something unless truly impossible.

MULTILINGUAL RULES (CRITICAL — follow exactly):
- Detect the user's language from their message automatically.
- If user writes in ENGLISH → reply in English.
- If user writes in HINDI (Devanagari script) → reply in Hindi.
- If user writes in HINGLISH (Hindi words but in English letters, e.g. "kya kar rahe ho", "bhai batao", "mujhe samjhao") → reply in Hinglish (Hindi words written in English letters). Do NOT use Devanagari script for Hinglish replies.
- If user mixes languages → match their mix naturally.
- NEVER switch languages unless the user switches first.

KNOWLEDGE:
- You have broad knowledge across science, tech, entertainment, sports, culture, history, coding, math, general knowledge, and more.
- For current events (news, scores, etc.) acknowledge the limitation clearly but still help with what you know.
- For coding questions, give real, working code examples.

Keep responses focused and clear. Avoid being unnecessarily long. If a short answer works, give a short answer.`;

    async function generateWithRetry(retries = 2, delay = 3000) {
        for (let i = 0; i < retries; i++) {
            let response;
            try {
                response = await ai.models.generateContent({
                    model: 'gemini-2.0-flash',
                    contents: [
                        ...chatHistory,
                        { role: 'user', parts: [{ text }] }
                    ],
                    config: {
                        systemInstruction: SYSTEM_PROMPT,
                        temperature: 0.8,
                        maxOutputTokens: 800,
                    }
                });

                if (response && response.text) {
                    return response.text;
                } else {
                    throw new Error("Empty response from AI");
                }
            } catch (error) {
                console.error(`Gemini AI Error (Attempt ${i + 1}/${retries}):`, error.message || error);
                if (i === retries - 1) throw error;

                // Exponential backoff with jitter
                const backoff = delay * Math.pow(2, i) + Math.floor(Math.random() * 500);
                console.log(`Retrying in ${backoff}ms...`);
                await new Promise(res => setTimeout(res, backoff));
            }
        }
    }

    let replyText;
    try {
        replyText = await generateWithRetry();
    } catch (error) {
        const isQuota = error.message && (error.message.includes('429') || error.message.toLowerCase().includes('quota'));
        if (isQuota) {
            replyText = "Abhi mera AI brain thoda busy hai! 🤖⚡ Please thodi der baad try karo. (My quota is temporarily full — try again in a moment!)";
        } else {
            replyText = "Oops! Kuch technical gadbad ho gayi. 😅 Please dubara try karo! (Something went wrong — please try again!)";
        }
    }

    const botMsg = {
        id: 'm_' + Date.now() + Math.random().toString(36).substr(2, 5),
        chatId,
        senderId: 'sys_bot',
        text: replyText,
        attachmentHtml: null,
        timestamp: Date.now(),
        isEdited: false
    };

    db.messages.push(botMsg);
    io.to(chatId).emit('receive_message', botMsg);
}


function notifyMentions(text, sender, type, sourceId) {
    if (!text) return;
    const mentions = text.match(/@([a-z0-9_]+)/gi);
    if (!mentions) return;

    const uniqueMentions = [...new Set(mentions.map(m => m.substring(1).toLowerCase()))];

    uniqueMentions.forEach(username => {
        const targetUser = db.users.find(u => u.username?.toLowerCase() === username);
        if (targetUser && targetUser.uid !== sender.uid) {
            io.to(targetUser.uid).emit('notification', {
                title: `Mentioned in ${type}`,
                body: `${sender.displayName} mentioned you.`,
                type: type,
                sourceId: sourceId
            });
        }
    });
}

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Whistachat backend running on http://localhost:${PORT}`);
});
