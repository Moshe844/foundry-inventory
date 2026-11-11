(function(){
  'use strict';
  var form=document.querySelector('[data-delivery-check-form]');
  var template=document.querySelector('[data-delivery-extra-template]');
  if(!form||!template)return;
  var button=form.querySelector('[data-add-delivery-row]');
  var container=form.querySelector('[data-delivery-extra-rows]');
  var notice=form.querySelector('[data-delivery-row-limit]');
  button.addEventListener('click',function(){
    var index=Number(form.dataset.nextRow);
    if(index>=500){
      notice.textContent='This comparison supports 500 delivery rows. Save these rows and compare the next delivery separately.';
      button.disabled=true;
      return;
    }
    var copy=template.content.cloneNode(true);
    copy.querySelectorAll('[name]').forEach(function(input){
      input.name=input.name.replace('__ROW__',String(index));
    });
    var first=copy.querySelector('input');
    container.appendChild(copy);
    form.dataset.nextRow=String(index+1);
    first.focus();
  });
}());
