const { io } = require('socket.io-client');
const socket = io('http://localhost:3000');

let passes = 0;
function checkDone() {
    if (passes >= 2) {
        console.log('✓ All tests passed successfully');
        process.exit(0);
    }
}

socket.on('connect', () => {
    console.log('Connected to server!');

    socket.emit('login', { email: 'kiran.desai3667@gmail.com', pass: 'incorrect' }, (res) => {
        if (res && res.success) {
            console.log('Admin login with incorrect pass worked? Failed tests.');
            process.exit(1);
        } else {
            console.log('✓ Login verification check works.');
            passes++;
            checkDone();
        }
    });

    socket.emit('admin_user_search', 'n', (res) => {
        if (res) {
            console.log('User search returned results');
            passes++;
            checkDone();
        } else {
            console.log('User search failed');
            process.exit(1);
        }
    });
});

setTimeout(() => {
    console.log('Timeout. Test Failed.');
    process.exit(1);
}, 3000);
