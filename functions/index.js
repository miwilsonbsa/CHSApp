/**
 * Camp Hi-Sierra – Cloud Functions
 * 1. Screens staff appreciation messages for inappropriate content
 * 2. Sends email notification to 19chs49@gmail.com
 * 3. Logs every appreciation to a Google Sheet
 * 4. Screens uploaded photos via Cloud Vision SafeSearch
 * 5. Emails app feedback to camp leadership
 */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const vision = require("@google-cloud/vision");

admin.initializeApp();

// Secrets & config stored in Firebase
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const SHEET_ID = "1P1o8Spgw2E5cg1ezmMwp1duOUsUy8aIkFZ0c1mPW4zA";

// ── Content screening ──────────────────────────────────────────
const BLOCKED_PATTERNS = [
  /\b(f+u+c+k+|s+h+i+t+|a+s+s+h+o+l+e+|b+i+t+c+h+|d+a+m+n+|c+r+a+p+|d+i+c+k+|p+i+s+s+)\b/,
  /\b(n+i+g+g+|f+a+g+|r+e+t+a+r+d+)\b/,
  /\b(sex+y?|porn|nude|naked|horny|boner|dildo|penis|vagina|boob(s|ie)?)\b/,
  /\b(weed|marijuana|cocaine|meth|heroin|drunk|beer|vodka|whiskey|tequila)\b/,
  /\b(kill\s+(you|him|her|them)|murder|shoot(ing)?|stab(bing)?|bomb|suicide)\b/,
  /\b(hate\s+you|you\s+suck|loser|ugly|stupid|idiot|moron|dumb(ass)?)\b/,
];

function screenContent(text) {
  const lower = text.toLowerCase();
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(lower)) {
      return { passed: false, reason: pattern.toString() };
    }
  }
  return { passed: true };
}

// ── Google Sheets helper ───────────────────────────────────────
async function appendToSheet(sheetId, rowData) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Sheet1!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [rowData],
    },
  });
}

// ── Firestore trigger ──────────────────────────────────────────
exports.onAppreciationCreated = onDocumentCreated(
  {
    document: "sessions/{sessionId}/testimonials/{docId}",
    secrets: [GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const docRef = snap.ref;
    const sessionId = event.params.sessionId;

    // ── Screen the message ─────────────────────────────────
    const result = screenContent(data.text || "");
    if (!result.passed) {
      await docRef.update({
        approved: false,
        flaggedReason: result.reason,
        screenedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`Flagged appreciation from ${data.author}: ${result.reason}`);
    }

    // ── Timestamp ──────────────────────────────────────────
    const now = new Date();
    const pacific = now.toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    // ── Log to Google Sheet ────────────────────────────────
    const sheetId = SHEET_ID;
    if (sheetId) {
      try {
        await appendToSheet(sheetId, [
          pacific,                          // A: Timestamp
          sessionId,                        // B: Session
          data.name || "",                  // C: Staff Member
          data.author || "",                // D: Submitted By
          data.troop || "",                 // E: Troop
          data.text || "",                  // F: Message
          result.passed ? "Approved" : "Flagged",  // G: Status
          data.submitterEmail || "",        // H: Leader Email
        ]);
        console.log("Logged to Google Sheet");
      } catch (err) {
        console.error("Sheet append failed:", err.message);
      }
    } else {
      console.warn("SHEET_ID is empty or not set — skipping Sheet logging");
    }

    // ── Send email notification ────────────────────────────
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "19chs49@gmail.com",
        pass: GMAIL_APP_PASSWORD.value(),
      },
    });

    const flagNote = !result.passed
      ? `\n⚠️ THIS MESSAGE WAS FLAGGED AND HIDDEN — reason: ${result.reason}\n`
      : "";

    const mailOptions = {
      from: '"Camp Hi-Sierra App" <19chs49@gmail.com>',
      to: "19chs49@gmail.com",
      subject: `⭐ Staff Appreciation: ${data.name || "Unknown"} — ${data.session || "CHS"}`,
      text: [
        `New Staff Appreciation Received`,
        `─────────────────────────────────`,
        `Staff Member: ${data.name || "N/A"}`,
        `From: ${data.author || "Anonymous"} (${data.troop || "No troop"})`,
        `Session: ${data.session || "N/A"}`,
        `Submitted by: ${data.submitterEmail || "Unknown"}`,
        ``,
        `Message:`,
        `"${data.text || ""}"`,
        flagNote,
        `─────────────────────────────────`,
        `View all appreciations in Firebase Console:`,
        `https://console.firebase.google.com/project/camphisierraapp/firestore`,
      ].join("\n"),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Email sent for appreciation of ${data.name}`);
    } catch (err) {
      console.error("Email send failed:", err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// APP FEEDBACK — email notification to camp leadership
// ══════════════════════════════════════════════════════════════
exports.onFeedbackCreated = onDocumentCreated(
  {
    document: "sessions/{sessionId}/feedback/{docId}",
    secrets: [GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const sessionId = event.params.sessionId;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "19chs49@gmail.com",
        pass: GMAIL_APP_PASSWORD.value(),
      },
    });

    const mailOptions = {
      from: '"Camp Hi-Sierra App" <19chs49@gmail.com>',
      to: "michael.wilson@scouting.org, 19chs49@gmail.com",
      subject: `💬 App Feedback (${data.category || "Other"}) — ${data.session || sessionId}`,
      text: [
        `New App Feedback Received`,
        `─────────────────────────────────`,
        `Type: ${data.category || "N/A"}`,
        `From: ${data.author || "Anonymous"} (${data.troop || "No troop"})`,
        `Session: ${data.session || sessionId}`,
        ``,
        `Message:`,
        `"${data.text || ""}"`,
        `─────────────────────────────────`,
        `View all feedback in Firebase Console:`,
        `https://console.firebase.google.com/project/camphisierraapp/firestore`,
      ].join("\n"),
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Feedback email sent (${data.category}) from ${data.author}`);
    } catch (err) {
      console.error("Feedback email send failed:", err);
    }
  }
);

// ══════════════════════════════════════════════════════════════
// PHOTO MODERATION — Cloud Vision SafeSearch + manual approval
// ══════════════════════════════════════════════════════════════
const visionClient = new vision.ImageAnnotatorClient();

// Likelihood levels: UNKNOWN, VERY_UNLIKELY, UNLIKELY, POSSIBLE, LIKELY, VERY_LIKELY
const UNSAFE_THRESHOLD = ["LIKELY", "VERY_LIKELY"];

function isUnsafe(safeSearch) {
  const checks = ["adult", "violence", "racy"];
  for (const cat of checks) {
    if (UNSAFE_THRESHOLD.includes(safeSearch[cat])) {
      return { flagged: true, category: cat, level: safeSearch[cat] };
    }
  }
  return { flagged: false };
}

exports.onPhotoCreated = onDocumentCreated(
  {
    document: "sessions/{sessionId}/photos/{docId}",
    secrets: [GMAIL_APP_PASSWORD],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data();
    const docRef = snap.ref;
    const sessionId = event.params.sessionId;
    const photoId = event.params.docId;

    const photoUrl = data.url;
    if (!photoUrl) {
      console.log("No URL on photo doc, skipping");
      return;
    }

    // ── 1. Run Cloud Vision SafeSearch ─────────────────────
    let safeResult;
    try {
      const [result] = await visionClient.safeSearchDetection(photoUrl);
      safeResult = result.safeSearchAnnotation;
      console.log(`SafeSearch result for ${photoId}:`, JSON.stringify(safeResult));
    } catch (err) {
      console.error("Vision API error:", err.message);
      // On Vision API failure, hold photo for manual review
      await docRef.update({
        approved: false,
        moderationStatus: "pending_review",
        moderationNote: "Vision API unavailable — held for manual review",
        screenedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }

    // ── 2. Check results ──────────────────────────────────
    if (!safeResult) {
      console.warn("SafeSearch returned null — holding for manual review");
      await docRef.update({
        approved: false,
        moderationStatus: "pending_review",
        moderationNote: "SafeSearch returned null — held for manual review",
        screenedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return;
    }
    const check = isUnsafe(safeResult);

    if (check.flagged) {
      // ── INAPPROPRIATE — take action ───────────────────
      console.log(`🚫 Photo ${photoId} FLAGGED: ${check.category} = ${check.level}`);

      // a) Mark the doc as rejected
      await docRef.update({
        approved: false,
        moderationStatus: "rejected",
        flaggedCategory: check.category,
        flaggedLevel: check.level,
        safeSearch: safeResult,
        screenedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // b) File kept in Storage for evidence/review — not deleted

      // c) Email camp leadership about the flagged photo
      const transporter = nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: "19chs49@gmail.com",
          pass: GMAIL_APP_PASSWORD.value(),
        },
      });

      await transporter.sendMail({
        from: '"Camp Hi-Sierra App" <19chs49@gmail.com>',
        to: "19chs49@gmail.com",
        subject: `🚫 FLAGGED PHOTO — ${data.session || sessionId}`,
        text: [
          `An inappropriate photo was automatically blocked and deleted.`,
          `─────────────────────────────────`,
          `Session: ${data.session || sessionId}`,
          `Uploaded by: ${data.uploadedBy || "Unknown"}`,
          `User ID: ${data.uid || "N/A"}`,
          `Email: ${data.uploaderEmail || "N/A"}`,
          `Filename: ${data.filename || "N/A"}`,
          ``,
          `Reason: ${check.category} content detected (${check.level})`,
          `Full SafeSearch: adult=${safeResult.adult}, violence=${safeResult.violence}, racy=${safeResult.racy}`,
          ``,
          `Action taken: Photo deleted from Storage, doc marked rejected.`,
          `The uploader's UID is ${data.uid} — you can identify them in the roster.`,
          `─────────────────────────────────`,
          `View Firestore: https://console.firebase.google.com/project/camphisierraapp/firestore`,
        ].join("\n"),
      });
      console.log("Admin notified about flagged photo");

    } else {
      // ── SAFE — auto-approve ───────────────────────────
      await docRef.update({
        approved: true,
        moderationStatus: "approved",
        safeSearch: safeResult,
        screenedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`✅ Photo ${photoId} auto-approved`);
    }
  }
);
