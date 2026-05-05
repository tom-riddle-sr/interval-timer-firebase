// firebase.js — Firebase Auth + Firestore wrapper (ES module, CDN)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider,
  signInWithPopup, signOut as fbSignOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, doc, setDoc, getDoc,
  collection, addDoc, query, orderBy, limit, getDocs,
  serverTimestamp, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAzqbXnfZ0w8JBI1J1U2zBe_sQUShgRVnE",
  authDomain: "interval-timer-cec3f.firebaseapp.com",
  projectId: "interval-timer-cec3f",
  storageBucket: "interval-timer-cec3f.firebasestorage.app",
  messagingSenderId: "667082384217",
  appId: "1:667082384217:web:2971ff07607ec32f0fe248",
  measurementId: "G-2Q0TWBT2P7"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ------- Auth -------
const provider = new GoogleAuthProvider();

export async function signIn() {
  return signInWithPopup(auth, provider);
}
export async function signOut() {
  return fbSignOut(auth);
}
export function onAuthChange(cb) {
  return onAuthStateChanged(auth, cb);
}
export function currentUser() {
  return auth.currentUser;
}

// ------- Firestore: settings -------
// users/{uid}/meta/settings
export async function loadSettings(uid) {
  const ref = doc(db, "users", uid, "meta", "settings");
  const snap = await getDoc(ref);
  return snap.exists() ? snap.data() : null;
}
export async function saveSettings(uid, data) {
  const ref = doc(db, "users", uid, "meta", "settings");
  await setDoc(ref, {
    ...data,
    updatedAt: serverTimestamp()
  });
}

// ------- Firestore: workouts -------
// users/{uid}/workouts/{auto}
export async function logWorkout(uid, record) {
  const col = collection(db, "users", uid, "workouts");
  return addDoc(col, {
    ...record,
    completedAt: serverTimestamp()
  });
}
export async function listWorkouts(uid, max = 100) {
  const col = collection(db, "users", uid, "workouts");
  const q = query(col, orderBy("completedAt", "desc"), limit(max));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
export async function deleteWorkout(uid, id) {
  await deleteDoc(doc(db, "users", uid, "workouts", id));
}
