'use strict';

document.addEventListener('click',event=>{
  const button=event.target.closest('[data-count-add]');
  if(!button)return;
  const form=button.form;
  const entries=form.querySelector('[data-count-entries]');
  const next=String(entries.children.length);
  const row=form.querySelector('[data-count-entry-template]').content.cloneNode(true);
  for(const input of row.querySelectorAll('input'))input.name=input.name.replace('ENTRY',next);
  const first=row.querySelector('input');
  entries.append(row);
  first.focus();
});
