import {shapePathScale} from './shape-path-scale.js';

// Restrict the new projection to opaque rectangular fills. Curves, strokes,
// effects and rotations retain their established drawing-display families.
export function rectanglePathBounds(path,width,height) {
  if(path.points.some((p,i)=>p[0]==='Z' && i!==path.points.length-1))return;
  const points=path.points.filter(p=>p[0]!=='Z');
  if(points.length===5 && points[4][0]==='L' && points[4][1]===points[0][1] && points[4][2]===points[0][2])points.pop();
  if(points.length!==4 || points[0][0]!=='M' || points.slice(1).some(p=>p[0]!=='L'))return;
  const xs=[...new Set(points.map(p=>p[1]))],ys=[...new Set(points.map(p=>p[2]))];
  if(xs.length!==2 || ys.length!==2 || points.some(p=>!Number.isFinite(p[1])||!Number.isFinite(p[2])))return;
  if(new Set(points.map(p=>`${p[1]},${p[2]}`)).size!==4)return;
  if(points.some((p,i)=>p[1]!==points[(i+1)%4][1] && p[2]!==points[(i+1)%4][2]))return;
  const sx=shapePathScale(width,path.width),sy=shapePathScale(height,path.height);
  const x=Math.min(...xs)*sx,y=Math.min(...ys)*sy,w=(Math.max(...xs)-Math.min(...xs))*sx,h=(Math.max(...ys)-Math.min(...ys))*sy;
  return w>0&&h>0 ? {x,y,width:w,height:h} : undefined;
}

export function supportsSolidRectangleDisplay(asset) {
  if(asset.shadow || asset.effects || asset.scene.effects || asset.scene.type==='picture3d')return false;
  let filled=false;
  const visit=node=>{
    if(!['shape','group'].includes(node.type) || node.text || node.shadow || node.outline || node.flipH || node.flipV ||
       node.groupRotation || node.shapeRotation || node.lineRotation || node.pictureRotation || node.pictureOutline)return false;
    if(node.type==='group')return !!node.width&&!!node.height&&node.childWidth!==0&&node.childHeight!==0&&(node.children||[]).every(visit);
    if(!/^#[\da-f]{6}$/i.test(node.fill||''))return false;
    for(const path of node.paths||[]){
      if(!path.fill)continue;
      if(path.fillMode&&path.fillMode!=='norm' || !rectanglePathBounds(path,node.width,node.height))return false;
      filled=true;
    }
    return true;
  };
  return visit(asset.scene)&&filled;
}

export function solidRectangleDeviceFrame(m,scale,rect,grouped=false) {
  if(!(scale>0 && m.a>0 && m.d>0) || m.b!==0 || m.c!==0)return;
  if(!rect || ![scale,m.a,m.d,m.e,m.f,rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || !(rect.width>0&&rect.height>0))return;
  const {x,y,width,height}=rect;
  const extent=value=>{
    const twips=value/scale*15;
    const whole=Math.trunc(twips+Number.EPSILON*Math.max(1,Math.abs(twips))*8);
    return Math.max(1,Math.round(whole/15*scale));
  };
  const left=Math.round(m.e+m.a*x),top=Math.round(m.f+m.d*y);
  // Child rectangles in a group use independently projected near/far edges.
  // Standalone shapes instead project whole-twip extents. Both keep
  // positive subpixel fills visible at a minimum of one device pixel.
  return {x:left,y:top,width:grouped?Math.max(1,Math.round(m.e+m.a*(x+width))-left):extent(m.a*width),
    height:grouped?Math.max(1,Math.round(m.f+m.d*(y+height))-top):extent(m.d*height)};
}

export function projectedSolidRectangle(path,width,height,matrix,display,resolution,left,top) {
  const factor=resolution/display.scale;
  // Use the scene's double-precision physical transform, not Canvas's
  // float-rounded matrix: a whole-twip width must not become slightly smaller.
  const m={a:matrix.a*display.scale,b:0,c:0,d:matrix.d*display.scale,e:(matrix.e-left)*display.scale,f:(matrix.f-top)*display.scale};
  if(matrix.grouped){
    m.e+=Math.round(display.x*display.scale)-display.x*display.scale;
    m.f+=Math.round(display.y*display.scale)-display.y*display.scale;
  }
  const rect=solidRectangleDeviceFrame(m,display.scale,rectanglePathBounds(path,width,height),matrix.grouped);
  const projected=new Path2D();projected.rect(rect.x*factor,rect.y*factor,rect.width*factor,rect.height*factor);return projected;
}

export function solidRectanglePaints(matrices) {
  const rectangles=[];
  for(const [node,m] of matrices)for(const path of node.paths){
    if(!path.fill)continue;
    const r=rectanglePathBounds(path,node.width,node.height);
    rectangles.push({x:m.e+m.a*r.x,y:m.f+m.d*r.y,width:m.a*r.width,height:m.d*r.height,color:node.fill,grouped:m.grouped});
  }
  return rectangles;
}

export function paintSolidRectangleDisplay(ctx,rectangles,x,y,width,height,frameWidth,frameHeight,scale) {
  if(!(scale>0&&width>0&&height>0&&frameWidth>0&&frameHeight>0) || ctx.globalAlpha!==1 || ctx.globalCompositeOperation!=='source-over')return false;
  const m=ctx.getTransform();
  // The normal page transform is known precisely from the caller. Do not
  // reconstruct physical sizes from Canvas's float-rounded matrix. Other
  // affine/cropped callers retain the raster path and its composition order.
  if(m.b!==0||m.c!==0||m.e!==0||m.f!==0||m.a!==m.d||m.a!==scale&&m.a!==Math.fround(scale))return false;
  const transform={a:scale*width/frameWidth,b:0,c:0,d:scale*height/frameHeight,e:scale*x,f:scale*y};
  const groupTransform={...transform,e:Math.round(transform.e),f:Math.round(transform.f)};
  ctx.save();ctx.resetTransform();
  try{
    for(const r of rectangles){
      const frame=solidRectangleDeviceFrame(r.grouped?groupTransform:transform,scale,r,r.grouped);
      ctx.fillStyle=r.color;ctx.fillRect(frame.x,frame.y,frame.width,frame.height);
    }
  }finally{ctx.restore();}
  return true;
}
