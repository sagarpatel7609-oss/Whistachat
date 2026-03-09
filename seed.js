require('dotenv').config();
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get, set } = require("firebase/database");

const firebaseConfig = {
    apiKey: "AIzaSyC7DRqeFJ-ez6p86uMXUc_X7cjtseeKX5Y",
    authDomain: "whistachat-6346f.firebaseapp.com",
    databaseURL: "https://whistachat-6346f-default-rtdb.firebaseio.com",
    projectId: "whistachat-6346f",
    storageBucket: "whistachat-6346f.firebasestorage.app",
    messagingSenderId: "30432329736",
    appId: "1:30432329736:web:9b0e6dc10609ca400e11bd"
};

const firebaseApp = initializeApp(firebaseConfig);
const firebaseDb = getDatabase(firebaseApp);

async function seedUsers() {
    try {
        const snapshot = await get(ref(firebaseDb, 'whistachat_db'));
        let db = snapshot.exists() ? snapshot.val() : {};
        if (!db.users) db.users = [];

        const defaultBot = {
            uid: 'sys_bot',
            email: 'bot@whistachat.com',
            username: 'whista_bot',
            displayName: 'Whistachat.AI',
            role: 'bot',
            isVerified: true,
            avatarUrl: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?q=80&w=200&h=200&fit=crop',
            followers: [],
            following: []
        };

        const testUser1 = {
            uid: 'sys1',
            email: 'admin@whistachat.com',
            password: 'password123',
            username: 'neon.admin',
            displayName: 'Neon Admin',
            role: 'owner',
            isVerified: true,
            avatarUrl: 'https://i.pravatar.cc/100?img=12',
            followers: [],
            following: []
        };

        const testUser2 = {
            uid: 'sys2',
            email: 'test@whistachat.com',
            password: 'password123',
            username: 'testuser',
            displayName: 'Test User',
            role: 'user',
            isVerified: false,
            avatarUrl: 'https://i.pravatar.cc/100?img=5',
            followers: [],
            following: []
        };

        if (!db.users.find(u => u.uid === 'sys_bot')) db.users.push(defaultBot);
        if (!db.users.find(u => u.uid === 'sys1')) db.users.push(testUser1);
        if (!db.users.find(u => u.uid === 'sys2')) db.users.push(testUser2);

        await set(ref(firebaseDb, 'whistachat_db'), db);
        console.log("Database seeded successfully.");
        process.exit(0);
    } catch (error) {
        console.error("Error seeding database:", error);
        process.exit(1);
    }
}

seedUsers();
