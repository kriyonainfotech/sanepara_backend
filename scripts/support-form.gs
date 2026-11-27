function installSupportFormTrigger() {
  const form = FormApp.getActiveForm();
  const exists = ScriptApp.getProjectTriggers().some((trigger) =>
    trigger.getHandlerFunction() === 'sendSupportQuery' && trigger.getTriggerSourceId() === form.getId()
  );
  if (!exists) ScriptApp.newTrigger('sendSupportQuery').forForm(form).onFormSubmit().create();
}

function sendSupportQuery(event) {
  const properties = PropertiesService.getScriptProperties();
  const endpoint = properties.getProperty('CRM_SUPPORT_URL');
  const secret = properties.getProperty('SUPPORT_FORM_SECRET');
  if (!endpoint || !secret) throw new Error('Set CRM_SUPPORT_URL and SUPPORT_FORM_SECRET in Script Properties');
  const response = event.response;
  const answers = response.getItemResponses().map((item) => {
    const value = item.getResponse();
    return { question: item.getItem().getTitle(), answer: Array.isArray(value) ? value.join(', ') : String(value ?? '') };
  });
  const categoryQuestion = properties.getProperty('SUPPORT_CATEGORY_QUESTION');
  const categoryAnswers = categoryQuestion ? answers.filter((item) => item.question === categoryQuestion) : answers;
  const responseCategory = categoryAnswers.map((item) => item.answer.trim().toLowerCase());
  const category = responseCategory.some((value) => ['complain', 'complaint'].includes(value)) ? 'Complaint'
    : responseCategory.includes('application status') ? 'Application Status' : 'Other';
  const result = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Support-Form-Secret': secret },
    payload: JSON.stringify({
      responseId: response.getId(),
      submittedAt: response.getTimestamp().toISOString(),
      email: response.getRespondentEmail() || '',
      category,
      answers,
    }),
    muteHttpExceptions: true,
  });
  if (result.getResponseCode() >= 300) throw new Error('CRM support intake returned HTTP ' + result.getResponseCode());
}
