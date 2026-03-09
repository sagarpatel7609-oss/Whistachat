require('dotenv').config();
const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get } = require("firebase/database");
const firebaseConfig = {
    apiKey: "AIzaSyC7DRqeFJ-ez6p86uMXUc_X7cjtseeKX5Y",
    authDomain: "whistachat-6346f.firebaseapp.com",
    databaseURL: "https://whistachat-6346f-default-rtdb.firebaseio.com",
    projectId: "whistachat-6346f",
    storageBucket: "whistachat-6346f.firebasestorage.app",
    messagingSenderId: "30432329736",
    appId: "1:30432329736:web:9b0e6dc10609ca400e11bd"
};
const firebaseDb = getDatabase(initializeApp(firebaseConfig));

async function check() {
    const snapshot = await get(ref(firebaseDb, 'whistachat_db/users'));
    console.log(snapshot.val());
    process.exit(0);
}
check();
