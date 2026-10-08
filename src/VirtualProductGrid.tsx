import { useEffect,useRef,useState,type ReactNode } from 'react';
import { virtualWindow } from './shared/virtual-window';
import type { Product } from './shared/types';

export default function VirtualProductGrid({items,renderItem,resetKey}:{items:Product[];renderItem:(product:Product)=>ReactNode;resetKey:string}){
  const viewport=useRef<HTMLDivElement>(null);const [columns,setColumns]=useState(3),[top,setTop]=useState(0);
  const rowHeight=335,height=Math.min(650,Math.ceil(items.length/columns)*rowHeight);
  useEffect(()=>{const node=viewport.current;if(!node)return;const observer=new ResizeObserver(entries=>setColumns(Math.max(1,Math.floor(entries[0].contentRect.width/230))));observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{setTop(0);if(viewport.current)viewport.current.scrollTop=0;},[resetKey]);
  const window=virtualWindow(items.length,columns,top,height,rowHeight);
  return <div ref={viewport} className="virtual-catalog" style={{height}} onScroll={event=>setTop(event.currentTarget.scrollTop)}><div style={{height:window.totalHeight,position:'relative'}}>{Array.from({length:window.end-window.start},(_,offset)=>{const row=window.start+offset;return <div className="virtual-product-row" key={row} style={{top:row*rowHeight,gridTemplateColumns:`repeat(${columns}, minmax(0,1fr))`}}>{items.slice(row*columns,(row+1)*columns).map(renderItem)}</div>;})}</div></div>;
}
