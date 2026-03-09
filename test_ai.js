const io = require("socket.io-client");

const socket = io("http://localhost:3000");

socket.on("connect", () => {
    console.log("Connected to server...");

    // 1. Sign up as test user
    socket.emit("signup", { email: "autotest1@test.com", pass: "pass123" }, (res) => {
        if (!res.success) {
            console.error("Signup failed:", res.message);
            process.exit(1);
        }
        console.log("Signed up successfully!");

        // 2. Complete setup
        socket.emit("complete_setup", { username: "autotester1" }, (setupRes) => {
            console.log("Setup complete!");

            // 3. Join chat with bot
            const botId = 'sys_bot';
            const arr = [res.user.uid, botId].sort();
            const chatId = `chat_${arr[0]}_${arr[1]}`;

            socket.emit("join_chat", chatId);

            // 4. Send hardcoded message
            console.log("Sending: Tumhe kisne banaya hai?");
            socket.emit("send_message", {
                chatId: chatId,
                text: "Tumhe kisne banaya hai?",
                attachmentHtml: null
            });

            setTimeout(() => {
                console.log("Sending: What are the top 2 global news headlines right now?");
                socket.emit("send_message", {
                    chatId: chatId,
                    text: "What are the top 2 global news headlines right now?",
                    attachmentHtml: null
                });
            }, 3000);

            setTimeout(() => {
                console.log("Sending: Aaj ki taaza khabar batao.");
                socket.emit("send_message", {
                    chatId: chatId,
                    text: "Aaj ki taaza khabar batao.",
                    attachmentHtml: null
                });
            }, 10000);
        });
    });
});

let msgCount = 0;
socket.on("receive_message", (msg) => {
    if (msg.senderId === 'sys_bot') {
        console.log("\n--- BOT REPLY ---");
        console.log(msg.text);
        console.log("-----------------\n");
        msgCount++;

        if (msgCount >= 3) {
            console.log("All tests completed. Exiting.");
            process.exit(0);
        }
    }
});
