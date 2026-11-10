'use strict';
// PDF geometry only: no document interpretation or business facts.
function regions(pdf,operators,viewport){let matrix=[1,0,0,1,0,0],stack=[],boxes=[],unknown=false;const point=(x,y)=>{const t=viewport.transform;return [t[0]*x+t[2]*y+t[4],t[1]*x+t[3]*y+t[5]];};const mul=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
 for(let i=0;i<operators.fnArray.length;i++){const fn=operators.fnArray[i],args=operators.argsArray[i];if(fn===pdf.OPS.save)stack.push([...matrix]);else if(fn===pdf.OPS.restore){if(stack.length)matrix=stack.pop();else unknown=true;}else if(fn===pdf.OPS.transform)matrix=mul(matrix,args);else if(fn===pdf.OPS.paintFormXObjectBegin){stack.push([...matrix]);if(args[0])matrix=mul(matrix,args[0]);}else if(fn===pdf.OPS.paintFormXObjectEnd){if(stack.length)matrix=stack.pop();else unknown=true;}
  else if([pdf.OPS.paintImageXObject,pdf.OPS.paintInlineImageXObject,pdf.OPS.paintImageMaskXObject,pdf.OPS.paintJpegXObject].includes(fn)){const points=[[0,0],[1,0],[0,1],[1,1]].map(([x,y])=>point(matrix[0]*x+matrix[2]*y+matrix[4],matrix[1]*x+matrix[3]*y+matrix[5]));boxes.push({x0:Math.min(...points.map(p=>p[0])),y0:Math.min(...points.map(p=>p[1])),x1:Math.max(...points.map(p=>p[0])),y1:Math.max(...points.map(p=>p[1]))});}
  else if(fn===pdf.OPS.beginAnnotation||fn===pdf.OPS.beginGroup)unknown=true;else if([pdf.OPS.paintImageXObjectRepeat,pdf.OPS.paintImageMaskXObjectRepeat,pdf.OPS.paintImageMaskXObjectGroup,pdf.OPS.paintInlineImageXObjectGroup].filter(v=>v!==undefined).includes(fn))unknown=true;
 }return {boxes,unknown};
}
module.exports={regions};
