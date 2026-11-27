'use strict';

function requestInput(title, fields, validate) {
  if (document.querySelector('.input-dialog[open]')) return Promise.resolve(null);
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'input-dialog';
    dialog.setAttribute('aria-label', title);
    const heading = document.createElement('h2');
    heading.textContent = title;
    const form = document.createElement('form');
    const inputs = fields.map((field) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      label.textContent = field.label;
      input.className = 'text-input';
      input.type = field.type || 'text';
      input.dir = 'ltr';
      input.required = true;
      input.autocomplete = field.autocomplete || 'off';
      label.append(input);
      form.append(label);
      return input;
    });

    const error = document.createElement('p');
    error.className = 'input-dialog-error';
    error.setAttribute('role', 'alert');
    const actions = document.createElement('div');
    actions.className = 'input-dialog-actions';
    const accept = document.createElement('button');
    accept.type = 'submit';
    accept.className = 'btn btn-primary';
    accept.textContent = 'אישור';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'ביטול';
    actions.append(accept, cancel);
    form.append(error, actions);
    dialog.append(heading, form);

    let result = null;
    cancel.onclick = () => dialog.close();
    form.onsubmit = (event) => {
      event.preventDefault();
      const values = inputs.map((input) => input.value);
      const problem = validate ? validate(values) : '';
      error.textContent = problem || '';
      if (problem) return;
      result = values;
      dialog.close();
    };
    dialog.addEventListener('keydown', (event) => event.stopPropagation());
    dialog.addEventListener('close', () => {
      form.reset();
      dialog.remove();
      resolve(result);
    }, { once: true });
    document.body.append(dialog);
    dialog.showModal();
    inputs[0].focus();
  });
}

function requestRecoveryDetails() {
  return requestInput('שחזור סיסמת הורה', [
    { label: 'הקוד שנשלח למייל', autocomplete: 'one-time-code' },
    { label: 'סיסמה חדשה (4–20 תווים ללא רווחים)', type: 'password', autocomplete: 'new-password' },
    { label: 'אימות הסיסמה החדשה', type: 'password', autocomplete: 'new-password' }
  ], ([code, pin, confirmation]) => {
    if (!code.trim()) return 'הזינו את קוד השחזור';
    if (!window.TimeScheduler.isValidPassword(pin)) return 'הסיסמה צריכה לכלול 4–20 תווים ללא רווחים';
    if (pin !== confirmation) return 'הסיסמאות אינן תואמות';
    return '';
  });
}
