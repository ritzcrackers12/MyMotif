// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getStorage, ref, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

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
const storage = getStorage(app);
const provider = new GoogleAuthProvider();

export { auth, db, storage, provider, signInWithPopup, signInWithRedirect, onAuthStateChanged, signOut, doc, setDoc, getDoc, ref, uploadString, getDownloadURL };
