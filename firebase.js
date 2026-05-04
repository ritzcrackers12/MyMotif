// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, setPersistence, browserLocalPersistence, browserSessionPersistence, inMemoryPersistence } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";


import { getFirestore, doc, setDoc, getDoc, collection, getDocs, addDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBJcqeZgo9Xp6TdPkxXV-u8sVGmelSfyGc",
  authDomain: "mymotiffinal.firebaseapp.com",
  databaseURL: "https://mymotiffinal-default-rtdb.firebaseio.com",
  projectId: "mymotiffinal",
  storageBucket: "mymotiffinal.firebasestorage.app",
  messagingSenderId: "263639986017",
  appId: "1:263639986017:web:a459ccb43c264be32edf20"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });


export {
    auth,
    db,
    provider,
    signInWithPopup,
    signInWithRedirect,
    getRedirectResult,
    onAuthStateChanged,
    signOut,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    inMemoryPersistence,
    doc,
    setDoc,
    getDoc,
    collection,
    getDocs,
    addDoc,
    deleteDoc,
    serverTimestamp
};

