<img src="docs/readme-banner.svg" alt="HonorRoll — Where assignments earn their grade." width="100%" />

A multi-tenant school platform combining an LMS, a coding-assessment judge, and proctored online exams — for four roles (student, teacher, admin, superadmin), with both a React web app and a React Native/Expo mobile app.

## What it does

- **Assignments** — coding problems judged by a real server-side sandbox (10 languages: Python, C, C++, Java, JS, TS, Go, Rust, Ruby, PHP), plus scan-mode paper assignments (camera capture → PDF, OCR graded after the deadline).
- **Exams** — one timed attempt covering mcq/short/long/coding/scan items, with optional live webcam proctoring (on-device face/object/audio detection) and browser lockdown.
- **Doubts** — students ask questions with photo/video/PDF attachments; teachers reply in a thread; non-blocking "similar doubts" suggestions before posting.
- **Notes & Notices** — teacher-posted study material and org-wide announcements.
- **Gradebook & grading policy** — class averages, percentile bands, custom grade thresholds, webhook integrations.
- **Org administration** — org-unit/subject/teacher/student structure, institution branding, billing (Razorpay), security-event audit log, and cross-org superadmin oversight.

## Layout

```
backend/    Node/Express API, Postgres, S3, sandboxed code execution
frontend/   React (Vite) web app
ocr-space/  OCR service for scanned assignments
```

## Running locally

**Backend**
```
cd backend
npm install
npm test          # jest
node index.js      # reads .env — DATABASE_URL, JWT_SECRET, etc.
```

**Frontend**
```
cd frontend
npm install
npm run dev         # vite dev server
npm run build        # production build
```

**Full stack via Docker**
```
docker-compose up
```
Brings up Postgres, Redis, the backend, and nginx per `docker-compose.yml`.

## Configuration

Each app reads its own `.env` (not committed). The backend expects, among others: `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRATION`, `FRONTEND_URL`, `SANDBOX_UID`/`SANDBOX_GID`/`SANDBOX_CONCURRENCY` (code-execution sandbox), `GMAIL_*` (mail), `RAZORPAY_*` (billing), `OCR_*`/`GROQ_API_KEY`/`GEMINI_API_KEY`/`HF_TOKEN` (scanned-assignment OCR), `SUPERADMIN_EMAILS`, `PLATFORM_OWNER_SECRET`. See `backend/.env` for the full list.

## License

All rights reserved. This source is public for visibility; it is not licensed for reuse, modification, or redistribution.
