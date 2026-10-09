# SmartCare AI — Firebase setup

This version keeps the original HTML/CSS/JS website and connects it to Cloud Functions, Cloud Firestore and Firebase Authentication. It is a starter project, not a clinically validated production system.

## 1. Create Firebase project
1. Go to https://console.firebase.google.com/ and create a project.
2. Project settings > General > Your apps > Add app > Web.
3. Copy `apiKey`, `authDomain`, `projectId`, and `appId` into `frontend/config.js`.
4. In Authentication > Sign-in method, enable **Email/Password**.
5. Create a **Cloud Firestore** database.
6. Replace `REPLACE_WITH_PROJECT_ID` in `SMARTCARE_API_BASE` with the project ID. The function region is `us-central1`.

## 2. Install Firebase tools
Install Node.js 20+ and then run:
```bash
npm install -g firebase-tools
firebase login
```
Open a terminal in the `smartcare-ai` folder (where `firebase.json` lives) and run:
```bash
firebase use --add
```
Choose your Firebase project.

## 3. Create a staff account and role
1. Firebase Console > Authentication > Users > Add user; create an email/password account.
2. Copy the user's UID.
3. Firestore > create collection `staffUsers`; create a document whose ID is exactly that UID.
4. Add fields:
   - `active` (boolean) = `true`
   - `role` (string) = `admin`, `nurse`, or `physician` for triage; use `front_desk` for viewing.
   - `displayName` (string) = a display name.
Only active staff with a profile can see patient details. Never allow users to write their own staff role.

## 4. Deploy
From the `smartcare-ai` folder:
```bash
cd functions
npm install
npm run build
cd ..
firebase deploy --only firestore:rules,functions,hosting
```
Check `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/api/health`, then open the Firebase Hosting URL.

## 5. Data and safeguards
The `patients` collection stores patient details, symptoms, token, department, status, urgency and assessment audit fields. Public routes expose only token, department, status and registration time. Staff details are protected by Firebase Authentication plus the server-side `staffUsers/{uid}` allowlist. Firestore direct client access is denied by rules.

Use synthetic/demo data only until security and clinical review. Qualified staff must make triage decisions; this software does not diagnose. Production requires abuse/rate limits, comprehensive audit/retention controls, monitoring, backups, privacy/legal review and clinical validation. Firebase Cloud Functions deployment may require a billing-enabled plan; confirm current requirements in the console.
