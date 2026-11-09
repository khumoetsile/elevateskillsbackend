'use strict';

const nodemailer = require('nodemailer');

const INTEREST_EMAIL_TO = (process.env.INTEREST_EMAIL_TO || 'help@elevateskills.online').trim();
const CONTACT_EMAIL_TO = (process.env.CONTACT_EMAIL_TO || 'help@elevateskills.online').trim();
// Fall back to the monitored contact inbox when SALES_EMAIL_TO is unset.
const SALES_EMAIL_TO = (process.env.SALES_EMAIL_TO || CONTACT_EMAIL_TO).trim();
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
  // Require a real SMTP password so empty local/dev config does not
  // attempt a send and fail after the enquiry was already saved.
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
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

    console.log(`[${logTag}] delivered to ${to}`);
    return { ok: true, delivered: true };
  } catch (err) {
    console.error(`[${logTag}] SMTP send failed (to ${to}):`, err.message);
    console.log(`[${logTag}] Would have sent — logging submission:`);
    console.log(mail.text);
    // Surface the failure so the API does not claim success when SMTP is configured.
    throw err;
  }
}

function enquiryTypeLabel(type) {
  switch (type) {
    case 'learner':
      return 'Learner support';
    case 'corporate':
      return 'Corporate training';
    case 'demo':
      return 'Demo request';
    case 'trainer':
      return 'Trainer / partner';
    default:
      return 'General enquiry';
  }
}

function uniqueEmailList(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const part of String(list || '').split(',')) {
      const email = part.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out.join(', ');
}

function contactRecipientForType(type) {
  // Demo / corporate / trainer go to sales, and also the contact inbox so
  // submissions are not lost when sales@ is unmonitored or misconfigured.
  if (type === 'demo' || type === 'corporate' || type === 'trainer') {
    return uniqueEmailList(SALES_EMAIL_TO, CONTACT_EMAIL_TO);
  }
  return CONTACT_EMAIL_TO;
}

function contactIntroForType(type) {
  switch (type) {
    case 'demo':
      return 'A demo request was submitted via the For Corporates page on elevateskills.online.';
    case 'trainer':
      return 'A trainer / partner application was submitted via the Trainers page on elevateskills.online.';
    case 'corporate':
      return 'A corporate training enquiry was submitted on elevateskills.online.';
    default:
      return 'A message was submitted via the Contact page on elevateskills.online.';
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
                ${escapeHtml(contactIntroForType(payload.type))}
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
                ${buildDetailRow('Company', payload.company)}
                ${payload.subject ? buildDetailRow('Subject', payload.subject) : ''}
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
    payload.subject ? `Subject: ${payload.subject}` : null,
    `Name: ${payload.name}`,
    `Email: ${payload.email}`,
    `Company: ${displayValue(payload.company)}`,
    `Phone: ${displayValue(payload.phone)}`,
    '',
    'Message:',
    payload.message,
    '',
    `Submitted: ${submittedAt.toISOString()}`
  ].filter((line) => line !== null);

  return {
    subject: `[Elevate Skills] ${enquiryType} - ${payload.name}`,
    text: lines.join('\n'),
    html: buildContactHtml(payload, submittedAt)
  };
}

function buildPurchaseLearnerEmail(order) {
  const portalUrl = (process.env.PUBLIC_LMS_URL || '').trim();
  const isNewUser = order.enrolment.user_created;
  const enrolled = order.enrolment.status === 'success';
  const amountLine = `${order.course.currency} ${Number(order.course.amount).toFixed(2)}`;

  const textLines = [
    `Hi ${order.buyer.first_name},`,
    '',
    enrolled
      ? `Thank you for your purchase! You are now enrolled in "${order.course.name}".`
      : `Thank you for your payment for "${order.course.name}". Your enrolment is being finalised and we will confirm shortly.`,
    '',
    `Order number: ${order.order_number}`,
    `Amount paid: ${amountLine}`,
    ''
  ];

  if (enrolled) {
    textLines.push('Access your course here:', portalUrl || 'Learner portal link to follow', '');
    if (isNewUser && order.enrolment.lms_login) {
      textLines.push(
        'A learner account was created for you:',
        `Username: ${order.enrolment.lms_login}`,
        `Temporary password: ${order.enrolment.lms_temp_password}`,
        'Please change your password after your first login.',
        ''
      );
    }
  }

  textLines.push('Need help? Reply to this email or contact help@elevateskills.online.', '', 'Elevate Skills — Empowering Skills. Elevating Potential.');

  const credentialsHtml =
    enrolled && isNewUser && order.enrolment.lms_login
      ? `<div style="margin:16px 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
           <p style="margin:0 0 6px;font-size:13px;color:#475569;font-weight:700;">Your learner account</p>
           <p style="margin:0;font-size:14px;color:#0f172a;">Username: <strong>${escapeHtml(order.enrolment.lms_login)}</strong></p>
           <p style="margin:4px 0 0;font-size:14px;color:#0f172a;">Temporary password: <strong>${escapeHtml(order.enrolment.lms_temp_password || '')}</strong></p>
           <p style="margin:8px 0 0;font-size:12px;color:#64748b;">Please change your password after your first login.</p>
         </div>`
      : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);padding:28px 32px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#bfdbfe;">Elevate Skills</p>
      <h1 style="margin:0;font-size:22px;color:#ffffff;">${enrolled ? 'You are enrolled!' : 'Payment received'}</h1>
    </div>
    <div style="padding:24px 32px;">
      <p style="font-size:14px;color:#0f172a;">Hi ${escapeHtml(order.buyer.first_name)},</p>
      <p style="font-size:14px;color:#0f172a;line-height:1.6;">
        ${
          enrolled
            ? `Thank you for your purchase! You are now enrolled in <strong>${escapeHtml(order.course.name)}</strong>.`
            : `Thank you for your payment for <strong>${escapeHtml(order.course.name)}</strong>. Your enrolment is being finalised and we will confirm shortly.`
        }
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
        <tr><td style="padding:8px 0;color:#64748b;">Order number</td><td style="padding:8px 0;color:#0f172a;font-weight:600;text-align:right;">${escapeHtml(order.order_number)}</td></tr>
        <tr><td style="padding:8px 0;color:#64748b;border-top:1px solid #e2e8f0;">Amount paid</td><td style="padding:8px 0;color:#0f172a;font-weight:600;text-align:right;border-top:1px solid #e2e8f0;">${escapeHtml(amountLine)}</td></tr>
      </table>
      ${credentialsHtml}
      ${
        enrolled && portalUrl
          ? `<p style="text-align:center;margin:20px 0;"><a href="${portalUrl}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px;font-size:14px;">Go to your course</a></p>`
          : ''
      }
      <p style="font-size:12px;color:#64748b;">Need help? Reply to this email or contact help@elevateskills.online.</p>
    </div>
    <div style="padding:16px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;text-align:center;">
      <p style="margin:0;font-size:12px;color:#64748b;"><strong style="color:#1e3a8a;">Elevate Skills</strong> · Empowering Skills. Elevating Potential.</p>
    </div>
  </div>
</body>
</html>`;

  return {
    subject: `[Elevate Skills] ${enrolled ? 'Enrolment confirmed' : 'Payment received'} — ${order.course.name} (${order.order_number})`,
    text: textLines.join('\n'),
    html
  };
}

function buildPurchaseAdminEmail(order) {
  const enrolled = order.enrolment.status === 'success';
  const lines = [
    `${enrolled ? 'New purchase completed' : 'PURCHASE NEEDS ATTENTION — enrolment failed'} - Elevate Skills`,
    '',
    `Order: ${order.order_number}`,
    `Status: ${order.status}`,
    `Course: ${order.course.name} (id ${order.course.id})`,
    `Amount: ${order.course.currency} ${Number(order.course.amount).toFixed(2)}`,
    `Provider: ${order.provider} (${order.provider_ref || '—'})`,
    '',
    `Buyer: ${order.buyer.first_name} ${order.buyer.last_name}`,
    `Email: ${order.buyer.email}`,
    `Phone: ${displayValue(order.buyer.phone)}`,
    '',
    `Enrolment: ${order.enrolment.status}`,
    `TalentLMS user: ${displayValue(order.enrolment.talentlms_user_id)} ${order.enrolment.user_created ? '(newly created)' : ''}`,
    order.enrolment.last_error ? `Error: ${order.enrolment.last_error}` : '',
    '',
    `Paid at: ${displayValue(order.payment.paid_at)}`
  ].filter((l) => l !== '');

  return {
    subject: `[Elevate Skills] ${enrolled ? 'Purchase' : 'ACTION REQUIRED: enrolment failed'} — ${order.order_number}`,
    text: lines.join('\n'),
    html: `<pre style="font-family:monospace;font-size:13px;">${escapeHtml(lines.join('\n'))}</pre>`
  };
}

/** Sends learner confirmation + admin notification after a paid order. */
async function sendPurchaseEmails(order) {
  const learnerMail = buildPurchaseLearnerEmail(order);
  const adminMail = buildPurchaseAdminEmail(order);
  const [learner, admin] = await Promise.all([
    deliverMail('purchase-learner', order.buyer.email, CONTACT_EMAIL_TO, learnerMail),
    deliverMail('purchase-admin', CONTACT_EMAIL_TO, order.buyer.email, adminMail)
  ]);
  return { learner, admin };
}

async function sendInterestEmail(payload) {
  const mail = buildInterestEmail(payload);
  return deliverMail('register-interest', INTEREST_EMAIL_TO, payload.email, mail);
}

async function sendContactEmail(payload) {
  const mail = buildContactEmail(payload);
  const to = contactRecipientForType(payload.type);
  return deliverMail('contact', to, payload.email, mail);
}

async function sendRegistrationWelcomeEmail({ firstName, email, login, password, portalUrl }) {
  const portal = (portalUrl || process.env.PUBLIC_LMS_URL || '').trim();
  const text = [
    `Hi ${firstName},`,
    '',
    'Welcome to Elevate Skills! Your learner account has been created.',
    '',
    `Username: ${login}`,
    `Temporary password: ${password}`,
    '',
    portal ? `Log in here: ${portal}` : 'Log in via the Elevate Skills learner portal.',
    'Please change your password after your first login.',
    '',
    'Browse courses at elevateskills.online to enrol and start learning.',
    '',
    'Need help? Contact help@elevateskills.online.',
    '',
    'Elevate Skills — Empowering Skills. Elevating Potential.'
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:24px;background:#f1f5f9;font-family:Inter,Segoe UI,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%);padding:28px 32px;">
      <p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#bfdbfe;">Elevate Skills</p>
      <h1 style="margin:0;font-size:22px;color:#ffffff;">Welcome — your account is ready</h1>
    </div>
    <div style="padding:24px 32px;">
      <p style="font-size:14px;color:#0f172a;">Hi ${escapeHtml(firstName)},</p>
      <p style="font-size:14px;color:#0f172a;line-height:1.6;">
        Your learner account has been created. Use the details below to sign in to the learning portal.
      </p>
      <div style="margin:16px 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">
        <p style="margin:0;font-size:14px;color:#0f172a;">Username: <strong>${escapeHtml(login)}</strong></p>
        <p style="margin:4px 0 0;font-size:14px;color:#0f172a;">Temporary password: <strong>${escapeHtml(password)}</strong></p>
        <p style="margin:8px 0 0;font-size:12px;color:#64748b;">Please change your password after your first login.</p>
      </div>
      ${
        portal
          ? `<p style="margin:16px 0;"><a href="${escapeHtml(portal)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;font-size:14px;">Open learner portal</a></p>`
          : ''
      }
      <p style="font-size:13px;color:#64748b;line-height:1.5;">
        To enrol in a course, browse the catalogue on elevateskills.online and complete checkout with this same email address.
      </p>
    </div>
  </div>
</body>
</html>`;

  return deliverMail(
    'registration-welcome',
    email,
    CONTACT_EMAIL_TO,
    {
      subject: '[Elevate Skills] Your learner account is ready',
      text,
      html
    }
  );
}

module.exports = {
  sendInterestEmail,
  sendContactEmail,
  sendPurchaseEmails,
  sendRegistrationWelcomeEmail,
  INTEREST_EMAIL_TO,
  CONTACT_EMAIL_TO,
  SALES_EMAIL_TO
};
