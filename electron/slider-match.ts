/** Local image matching only; no credentials or CAPTCHA tokens enter this module. */
export interface PixelImage { width: number; height: number; data: ArrayLike<number>; }
export interface SliderMatch { x: number; y: number; confidence: number; margin: number; method: 'texture' | 'edge'; }
function valid(image: PixelImage) {
  return Number.isInteger(image.width) && Number.isInteger(image.height) && image.width >= 8 && image.height >= 8 && image.width <= 1024 && image.height <= 512 && image.data.length === image.width * image.height * 4;
}
function gray(image: PixelImage): Float32Array {
  const result = new Float32Array(image.width * image.height);
  for (let i = 0; i < result.length; i++) result[i] = .2126 * image.data[4*i] + .7152 * image.data[4*i+1] + .0722 * image.data[4*i+2];
  return result;
}
function sobel(values: Float32Array, width: number, height: number): Float32Array {
  const result = new Float32Array(values.length);
  for (let y=1;y<height-1;y++) for(let x=1;x<width-1;x++) {
    const i=y*width+x;
    const dx=-values[i-width-1]+values[i-width+1]-2*values[i-1]+2*values[i+1]-values[i+width-1]+values[i+width+1];
    const dy=-values[i-width-1]-2*values[i-width]-values[i-width+1]+values[i+width-1]+2*values[i+width]+values[i+width+1];
    result[i]=Math.hypot(dx,dy);
  }
  return result;
}
export function matchSlider(background: PixelImage, piece: PixelImage, top: number, minX=12): SliderMatch | null {
  if(!valid(background)||!valid(piece)||piece.width>=background.width||piece.height>background.height||!Number.isFinite(top)||!Number.isFinite(minX))return null;
  const y0=Math.round(top);if(y0<0||y0+piece.height>background.height)return null;
  const bg=gray(background),fg=gray(piece),edges=sobel(bg,background.width,background.height);
  const boundary:Array<[number,number]>=[],interior:Array<[number,number,number]>=[];
  const alpha=(x:number,y:number)=>piece.data[4*(y*piece.width+x)+3];
  for(let y=2;y<piece.height-2;y+=2)for(let x=2;x<piece.width-2;x+=2){
    if(alpha(x,y)<220)continue;
    let opaque=0;
    for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(alpha(x+dx,y+dy)>=220)opaque++;
    if(opaque<25&&opaque>=8)boundary.push([x,y]);
    else if(opaque===25)interior.push([x,y,fg[y*piece.width+x]]);
  }
  if(boundary.length<12||interior.length<20)return null;
  const mean=interior.reduce((sum,p)=>sum+p[2],0)/interior.length;
  const variance=interior.reduce((sum,p)=>sum+(p[2]-mean)**2,0);
  const candidates:Array<{x:number;y:number;texture:number;edge:number;score:number}>=[];
  let maxEdge=0;
  for(let dy=-1;dy<=1;dy++){
    const y=y0+dy;if(y<0||y+piece.height>background.height)continue;
    for(let x=Math.max(0,Math.ceil(minX));x<=background.width-piece.width;x++){
      let sum=0,sum2=0,covariance=0,edge=0;
      for(const [px,py,value]of interior){const sample=bg[(y+py)*background.width+x+px];sum+=sample;sum2+=sample*sample;covariance+=(value-mean)*sample;}
      const sampleVariance=Math.max(0,sum2-sum*sum/interior.length);
      const texture=variance>interior.length*9&&sampleVariance>interior.length*9?covariance/Math.sqrt(variance*sampleVariance):0;
      for(const[px,py]of boundary){
        const index=(y+py)*background.width+x+px;
        edge+=Math.max(edges[index],edges[index-1],edges[index+1]);
      }
      edge/=boundary.length;maxEdge=Math.max(maxEdge,edge);
      candidates.push({x,y,texture,edge,score:0});
    }
  }
  if(!candidates.length||maxEdge<8)return null;
  for(const p of candidates)p.score=.8*Math.max(0,p.texture)+.2*p.edge/maxEdge;
  candidates.sort((a,b)=>b.score-a.score);
  const best=candidates[0],runner=candidates.find(p=>Math.abs(p.x-best.x)>Math.max(8,piece.width/4));
  const margin=best.score-(runner?.score??0);
  if(best.texture>=.58&&margin>=.025)return{x:best.x,y:best.y,confidence:Math.max(0,Math.min(1,best.texture)),margin,method:'texture'};
  // Low-texture images may still provide a distinctive complete puzzle outline.
  candidates.sort((a,b)=>b.edge-a.edge);
  const first=candidates[0],second=candidates.find(p=>Math.abs(p.x-first.x)>Math.max(8,piece.width/4));
  const ratio=first.edge/(second?.edge||1);
  if(first.edge>=30&&ratio>=1.22&&first.texture>=.1)return{x:first.x,y:first.y,confidence:Math.min(.9,ratio-1),margin:ratio-1,method:'edge'};
  return null;
}
