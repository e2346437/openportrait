# Questionnaires

Questionnaires collect details from a client before a shoot (timelines, names, the look they want). Answers are saved on the shoot.

## Building forms
Settings > Questionnaires. Start from a ready-made form (wedding, portrait or family, headshot) or a blank one. Question types: short answer, long answer, number, date, yes or no, pick one, pick several, and section titles. Any question can be required. Editing a form never changes copies already sent: each sent questionnaire keeps its own snapshot of the questions.

## Sending
- By hand: on a shoot, Questionnaires > Add. Save as a draft, or send straight away. Sent forms can be reminded, copied as a link, or asked again after the client answers.
- Automatically: in Settings > Questionnaires, choose a form for each shoot type and turn on "Send when booked". The main contact is emailed as soon as a shoot of that type is created. With no email address, or no mail setup, the form waits as a draft on the shoot.
- Sending on a schedule (for example 14 days before the shoot) comes later.

## Client page
Clients open a private link (`/q/<token>`), no sign-in. The link works only once the form is sent. After submitting, answers are locked; "Ask again" on the shoot reopens it. The studio gets an email when answers arrive and the contact's timeline records it.

## Connected AI
Tools: `questionnaire_templates_list`, `shoots_questionnaires` (answers come back wrapped as untrusted client text), `questionnaires_create` (draft) and `questionnaires_send` (needs owner approval). When the AI owns the "Send questionnaires" automation, the built-in send-on-booking rule stays quiet and the shoot appears in the work queue instead.

File-upload questions are not supported yet.
