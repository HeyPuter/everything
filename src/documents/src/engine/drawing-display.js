// Native screen controls currently establish pixel placement for axis-aligned
// solid vector scenes. Other content keeps its existing raster and origin.
export function supportsDrawingDisplay(asset) {
  if (asset.shadow || asset.effects || asset.scene.effects) return false;
  let outlined = false;
  const visit = node => {
    if (!['shape','group'].includes(node.type) || node.text || node.shadow || node.flipH || node.flipV ||
      node.groupRotation || node.shapeRotation || node.lineRotation || node.pictureRotation || node.pictureOutline ||
      node.fill && typeof node.fill !== 'string') return false;
    if (node.outline) {
      if (node.outline.compound || node.outline.headEnd || node.outline.tailEnd) return false;
      outlined = true;
    }
    if (node.paths?.some(p => p.fillMode && p.fillMode !== 'norm')) return false;
    if (node.type === 'group' && (!node.width || !node.height)) return false;
    return (node.children || []).every(visit);
  };
  return visit(asset.scene) && outlined;
}

export function drawingDisplayPlacement(placement, frame) {
  if (!placement || placement.axisAligned === false || placement.width !== frame.width || placement.height !== frame.height) return;
  const scale = placement.pixelRatio;
  const x = placement.originX ?? placement.x, y = placement.originY ?? placement.y;
  if (![scale,x,y].every(Number.isFinite) || scale <= 0) return;
  // Integer device-pixel translations share the same local raster.
  return {scale,x:((x*scale)%1+1)%1/scale,y:((y*scale)%1+1)%1/scale};
}

export function drawingDisplaySurface(bounds, display) {
  const {scale,x,y}=display, pad=2/scale;
  const left=Math.floor((bounds.left-pad+x)*scale)/scale-x;
  const top=Math.floor((bounds.top-pad+y)*scale)/scale-y;
  const right=Math.ceil((bounds.right+pad+x)*scale)/scale-x;
  const bottom=Math.ceil((bounds.bottom+pad+y)*scale)/scale-y;
  const width=right-left,height=bottom-top;
  const resolution=scale*Math.max(1,Math.ceil(2/scale));
  const pixelsWide=Math.max(1,Math.round(width*resolution)),pixelsHigh=Math.max(1,Math.round(height*resolution));
  if (width>4096 || height>4096 || width*height>4000000 || pixelsWide>8192 || pixelsHigh>8192 || pixelsWide*pixelsHigh>16000000) return;
  return {left,top,width,height,resolution,pixelsWide,pixelsHigh};
}

function ellipseDisplayExtent(value,scale) {
  return Math.round(Math.trunc(value/scale*15)/15*scale);
}

export function projectedDrawingPath(path,width,height,matrix,pen,display,resolution,append) {
  const factor=resolution/display.scale;
  const m={a:matrix.a/factor,b:matrix.b/factor,c:matrix.c/factor,d:matrix.d/factor,e:matrix.e/factor,f:matrix.f/factor};
  const x=Math.round(m.e),y=Math.round(m.f),offset=pen%2 ? .5 : 0;
  // Preserve half-pixel endpoint coverage for odd pens. Thresholded JPEG
  // footprints do not justify extending the path or making its caps opaque.
  // Axis-aligned preset ellipses use whole-twip physical extents,
  // rounded independently of their origin at the current device scale.
  // Apply this to the shared fill/stroke path, including scaled groups.
  const ellipse=path.points.length===2 && path.points[0][0]==='E' && path.points[1][0]==='Z' &&
    m.b===0 && m.c===0 && m.a>0 && m.d>0;
  const transform=new DOMMatrix([
    width ? (ellipse ? ellipseDisplayExtent(m.a*width,display.scale) : Math.round(m.e+m.a*width)-x)/width : m.a,
    width ? (Math.round(m.f+m.b*width)-y)/width : m.b,
    height ? (Math.round(m.e+m.c*height)-x)/height : m.c,
    height ? (ellipse ? ellipseDisplayExtent(m.d*height,display.scale) : Math.round(m.f+m.d*height)-y)/height : m.d,x+offset,y+offset]);
  const local=new Path2D();append(local,path,width,height);
  const device=new Path2D();device.addPath(local,transform);
  const physical=new Path2D();physical.addPath(device,new DOMMatrix([factor,0,0,factor,0,0]));
  return physical;
}
