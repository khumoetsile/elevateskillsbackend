'use strict';

const nodemailer = require('nodemailer');

const INTEREST_EMAIL_TO = (process.env.INTEREST_EMAIL_TO || 'help@elevateskills.online').trim();
const CONTACT_EMAIL_TO = (process.env.CONTACT_EMAIL_TO || 'help@elevateskills.online').trim();
const SMTP_HOST = (process.env.SMTP_HOST || '').trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const SMTP_USER = (process.env.SMTP_USER || '').trim();
const SMTP_PASS = (process.env.SMTP_PASS || '').trim();
const SMTP_FROM = (
  process.env.EMAIL_FROM ||
  process.env.SMTP_FROM ||
  SMTP_USER ||
  INTEREST_EMAIL_TO
).trim();
const SMTP_SECURE = process.env.SMTP_SECURE === 'true' || SMTP_PORT === 465;

function createMailTransport() {
  if (!SMTP_HOST) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
}

function intentLabel(intent) {
  switch (intent) {
    case 'enrol':
      return 'Course enrolment';
    case 'login':
      return 'Login / access';
    case 'register':
      return 'New registration';
    default:
      return 'General interest';
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function displayValue(value) {
  const text = String(value || '').trim();
  return text || '—';
}

function formatSubmittedAt(date = new Date()) {
  return date.toLocaleString('en-GB', {
    timeZone: 'Africa/Gaborone',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildDetailRow(label, value, options = {}) {
  const { link = false, last = false } = options;
  const safeValue = escapeHtml(displayValue(value));
  const valueHtml = link && value
    ? `<a href="mailto:${safeValue}" style="color:#1d4ed8;text-decoration:none;font-weight:600;">${safeValue}</a>`
    : `<span style="color:#0f172a;font-size:15px;font-weight:500;line-height:1.5;">${safeValue}</span>`;
  const border = last ? '' : 'border-bottom:1px solid #e2e8f0;';

  return `
    <tr>
      <td style="padding:14px 0;${border}">
        <div style="font-size:11px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;font-weight:700;margin-bottom:4px;">
          ${escapeHtml(label)}
        </div>
        ${valueHtml}
      </td>
    </tr>`;
}

function buildCoursesList(courses) {
  if (!courses.length) {
    return '<p style="margin:0;color:#64748b;font-size:14px;">—</p>';
  }

  return `
    <ul style="margin:0;padding:0;list-style:none;">
      ${courses
        .map(
          (course) => `
        <li style="margin:0 0 8px;padding:10px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:14px;line-height:1.5;">
          ${escapeHtml(course)}
        </li>`
        )
        .join('')}
    </ul>`;
}

function buildInterestHtml(payload, submittedAt) {
  const selectedCourses = Array.isArray(payload.selectedCourses)
    ? payload.selectedCourses.filter(Boolean)
    : [];
  const intent = intentLabel(payload.intent);
  const submitted = formatSubmittedAt(submittedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New interest registration</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Inter,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);padding:28px 32px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#bfdbfe;">
                Elevate Skills
              </p>
              <h1 style="margin:0 0 8px;font-size:24px;line-height:1.3;font-weight:800;color:#ffffff;">
                New interest registration
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#dbeafe;">
                A visitor submitted the Register Your Interest form on elevateskills.online.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;">
              <span style="display:inline-block;background-color:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:700;line-height:1;padding:8px 14px;border-radius:999px;border:1px solid #bfdbfe;">
                ${escapeHtml(intent)}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0;">
              <h2 style="margin:0 0 12px;font-size:13px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#475569;font-weight:700;">
                Contact details
              </h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${buildDetailRow('Full name', payload.name)}
                ${buildDetailRow('Email address', payload.email, { link: true })}
                ${buildDetailRow('Contact number', payload.phone)}
                ${buildDetailRow("Friend's contact number", payload.friendPhone, { last: true })}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <h2 style="margin:0 0 12px;font-size:13px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#475569;font-weight:700;">
                Course interest
              </h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;">
                ${buildDetailRow('Highlighted course', payload.course, { last: true })}
              </table>
              <p style="margin:0 0 10px;font-size:11px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;font-weight:700;">
                Selected courses / categories
              </p>
              ${buildCoursesList(selectedCourses)}
              ${
                payload.otherCourse
                  ? `<p style="margin:16px 0 6px;font-size:11px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;font-weight:700;">Other</p>
                     <p style="margin:0;padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:14px;line-height:1.6;">${escapeHtml(payload.otherCourse)}</p>`
                  : ''
              }
            </td>
          </tr>
          ${
            payload.message
              ? `<tr>
            <td style="padding:24px 32px 0;">
              <h2 style="margin:0 0 12px;font-size:13px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#475569;font-weight:700;">
                Message
              </h2>
              <p style="margin:0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(payload.message)}</p>
            </td>
          </tr>`
              : ''
          }
          <tr>
            <td style="padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;">
                <tr>
                  <td style="padding:14px 16px;">
                    <p style="margin:0 0 4px;font-size:11px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;font-weight:700;">
                      Consent
                    </p>
                    <p style="margin:0;font-size:14px;color:#0f172a;font-weight:600;">
                      ${payload.consent ? 'Yes — contact permitted' : 'No'}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:0 32px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                Submitted ${escapeHtml(submitted)} (Botswana time). Reply directly to this email to reach the applicant.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;text-align:center;">
                <strong style="color:#1e3a8a;">Elevate Skills</strong> · Empowering Skills. Elevating Potential.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildInterestEmail(payload) {
  const selectedCourses = Array.isArray(payload.selectedCourses)
    ? payload.selectedCourses.filter(Boolean)
    : [];
  const submittedAt = new Date();
  const lines = [
    'New Register Your Interest submission - Elevate Skills',
    '',
    `Intent: ${intentLabel(payload.intent)}`,
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Contact Number: ${displayValue(payload.phone)}`,
    `Friend's Contact Number: ${displayValue(payload.friendPhone)}`,
    `Highlighted Course: ${displayValue(payload.course)}`,
    '',
    'Selected Courses / Categories:',
    selectedCourses.length ? selectedCourses.map((item) => `- ${item}`).join('\n') : '—',
    `Other: ${displayValue(payload.otherCourse)}`,
    `Consent: ${payload.consent ? 'Yes' : 'No'}`,
    '',
    'Message:',
    displayValue(payload.message),
    '',
    `Submitted: ${submittedAt.toISOString()}`
  ];
  const subjectParts = [intentLabel(payload.intent)];
  if (payload.course) subjectParts.push(payload.course);
  subjectParts.push(payload.name);
  return {
    subject: `[Elevate Skills] ${subjectParts.join(' - ')}`,
    text: lines.join('\n'),
    html: buildInterestHtml(payload, submittedAt)
  };
}

async function deliverMail(logTag, to, replyTo, mail) {
  const transport = createMailTransport();

  if (!transport) {
    console.log(`[${logTag}] SMTP not configured - logging submission:`);
    console.log(mail.text);
    return { ok: true, delivered: false, logged: true };
  }

  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to,
      replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html
    });

    return { ok: true, delivered: true };
  } catch (err) {
    console.error(`[${logTag}] SMTP send failed:`, err.message);
    console.log(`[${logTag}] Would have sent to ${to} — logging submission:`);
    console.log(mail.text);
    return { ok: true, delivered: false, logged: true, error: err.message };
  }
}

function enquiryTypeLabel(type) {
  switch (type) {
    case 'learner':
      return 'Learner support';
    case 'corporate':
      return 'Corporate training';
    case 'trainer':
      return 'Trainer / partner';
    default:
      return 'General enquiry';
  }
}

function buildContactHtml(payload, submittedAt) {
  const enquiryType = enquiryTypeLabel(payload.type);
  const submitted = formatSubmittedAt(submittedAt);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>New contact enquiry</title>
</head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Inter,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);padding:28px 32px;">
              <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#bfdbfe;">
                Elevate Skills
              </p>
              <h1 style="margin:0 0 8px;font-size:24px;line-height:1.3;font-weight:800;color:#ffffff;">
                New contact enquiry
              </h1>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#dbeafe;">
                A message was submitted via the Contact page on elevateskills.online.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px;">
              <span style="display:inline-block;background-color:#eff6ff;color:#1d4ed8;font-size:12px;font-weight:700;line-height:1;padding:8px 14px;border-radius:999px;border:1px solid #bfdbfe;">
                ${escapeHtml(enquiryType)}
              </span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0;">
              <h2 style="margin:0 0 12px;font-size:13px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#475569;font-weight:700;">
                Contact details
              </h2>
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                ${buildDetailRow('Full name', payload.name)}
                ${buildDetailRow('Email address', payload.email, { link: true })}
                ${buildDetailRow('Phone', payload.phone, { last: true })}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 0;">
              <h2 style="margin:0 0 12px;font-size:13px;line-height:1.4;letter-spacing:0.06em;text-transform:uppercase;color:#475569;font-weight:700;">
                Message
              </h2>
              <p style="margin:0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;color:#0f172a;font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(payload.message)}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 28px;">
              <p style="margin:0;font-size:12px;line-height:1.6;color:#64748b;">
                Submitted ${escapeHtml(submitted)} (Botswana time). Reply directly to this email to reach the enquirer.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#64748b;text-align:center;">
                <strong style="color:#1e3a8a;">Elevate Skills</strong> · Empowering Skills. Elevating Potential.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildContactEmail(payload) {
  const submittedAt = new Date();
  const enquiryType = enquiryTypeLabel(payload.type);
  const lines = [
    'New contact enquiry - Elevate Skills',
    '',
    `Enquiry type: ${enquiryType}`,
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Phone: ${displayValue(payload.phone)}`,
    '',
    'Message:',
    payload.message,
    '',
    `Submitted: ${submittedAt.toISOString()}`
  ];

  return {
    subject: `[Elevate Skills] Contact - ${enquiryType} - ${payload.name}`,
    text: lines.join('\n'),
    html: buildContactHtml(payload, submittedAt)
  };
}

async function sendInterestEmail(payload) {
  const mail = buildInterestEmail(payload);
  return deliverMail('register-interest', INTEREST_EMAIL_TO, payload.email, mail);
}

async function sendContactEmail(payload) {
  const mail = buildContactEmail(payload);
  return deliverMail('contact', CONTACT_EMAIL_TO, payload.email, mail);
}

module.exports = {
  sendInterestEmail,
  sendContactEmail,
  INTEREST_EMAIL_TO,
  CONTACT_EMAIL_TO
};
