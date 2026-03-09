const io = require('socket.io-client');
const assert = require('assert');

const socket = io('http://localhost:3000');

socket.on('connect', () => {
    console.log('Connected to server!');

    socket.emit('login', { email: 'kiran.desai3667@gmail.com', pass: 'Kiran@3667' }, (res) => {
        console.log('Login Response:', res.success ? 'SUCCESS' : 'FAILED');
        if (res.success) {
            console.log('Logged in as:', res.user.email);
            console.log('Role:', res.user.role);
            // Test Role Hierarchy logic
            socket.emit('admin_action_user', { targetUid: 'u_1773036126341', action: 'warn' }, (actRes) => {
                console.log('Admin Warn Action:', actRes.success ? 'SUCCESS' : 'FAILED', actRes.message || '');
                // Wait to make sure logs process
                setTimeout(() => process.exit(0), 1000);
            });
        } else {
            console.log(res.message);
            process.exit(1);
        }
    });

    socket.on('notification', (n) => {
        console.log('Received notification:', n.title);
    });
});
