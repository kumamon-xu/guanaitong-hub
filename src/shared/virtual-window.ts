export function virtualWindow(count:number,columns:number,scrollTop:number,height:number,rowHeight:number,overscan=2){
  const rows=Math.ceil(count/Math.max(1,columns));
  const start=Math.max(0,Math.floor(scrollTop/rowHeight)-overscan),end=Math.min(rows,Math.ceil((scrollTop+height)/rowHeight)+overscan);
  return {start,end,totalHeight:rows*rowHeight};
}
