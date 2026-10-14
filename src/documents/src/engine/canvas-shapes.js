import { shapePathScale } from './shape-path-scale.js';
import { outlinePadding, pathLineEnds, paintLineEnds, trimLineEnds, markedOutlinePainter } from './drawing-line-ends.js';
import { paintImage } from './paint-image.js';
import { canvasLinearGradient, canvasCircularGradient } from './drawing-gradients.js';
import { canvasPatternFill, shapeHasPatterns } from './drawing-patterns.js';
import { resizeShapeFrame } from './shape-frame.js';
import { drawingGroupScale } from './drawing-group-scale.js';
import { transformedShapeBounds } from './transformed-shape-bounds.js';
import { drawingLineDash } from './drawing-line-dashes.js';
import { rotatedLinePoints } from './drawing-line-rotation.js';
import { drawingRotationMatrix, pictureRotationMatrix, composeDrawingRotation, drawingOrientation } from './drawing-picture-rotation.js';
import { layoutShapeText } from './shape-text-layout.js';
export { layoutShapeText } from './shape-text-layout.js';
import { setCanvasTextStyle, loadCanvasFonts, measureCanvasText, setCanvasFontAlternatives } from './canvas-text.js';
import { imageCropRect, EMU_PER_PX, inlineImagePaintFrame, normalizedRotation, ANGLE_PER_DEGREE, paintDecodedImage } from './images.js';
import { paintColor } from './colors.js';
import { pictureFillRect } from './picture-fills.js';
import { pictureTilePattern } from './picture-tiles.js';
import { bezierExtrema } from './bezier-bounds.js';
import { decodePicture3d } from './canvas-picture-3d.js';
import { shapeHasFields } from './shape-page-fields.js';
import { paintText, paintTextShadows } from './canvas-paint-text.js';
import { compoundOutlinePainter, compoundContours } from './compound-outlines.js';
import { pictureOutlineContours } from './picture-outline-offset.js';
import { paintPictureShadow } from './canvas-picture-shadow.js';
import { paintDrawingEffects } from './canvas-drawing-effects.js';
import { paintTableBorder } from './canvas-table-borders.js';
import { drawingRasterScale } from './drawing-raster-scale.js';
import { pointOutlinePosition } from './point-outline.js';
import { supportsDrawingDisplay, drawingDisplayPlacement, drawingDisplaySurface, projectedDrawingPath } from './drawing-display.js';
import {supportsSolidRectangleDisplay,projectedSolidRectangle,solidRectanglePaints,paintSolidRectangleDisplay} from './solid-rectangle-display.js';

function appendPath(ctx, path, width, height) {
  for (const command of path.points) {
    const [op, x, y] = command;
    const sx = shapePathScale(width, path.width), sy = shapePathScale(height, path.height);
    if (op === 'Z') ctx.closePath();
    else if (op === 'E') ctx.ellipse(width / 2, height / 2, width / 2, height / 2, 0, Math.PI, 3 * Math.PI);
    else if (op === 'C') ctx.bezierCurveTo(x*sx, y*sy, command[3]*sx, command[4]*sy, command[5]*sx, command[6]*sy);
    else if (op === 'Q') ctx.quadraticCurveTo(x*sx, y*sy, command[3]*sx, command[4]*sy);
    else ctx[op === 'M' ? 'moveTo' : 'lineTo'](x*shapePathScale(width, path.width), y*shapePathScale(height, path.height));
  }
}

// A custom picture's texture stretches over the filled path bounds,
// including curve extrema, rather than unused space in the transform frame.
export function pictureGeometryBounds(paths, width, height) {
  let left=Infinity, top=Infinity, right=-Infinity, bottom=-Infinity;
  for (const path of paths) if (path.fill) {
    let x=0, y=0, startX=0, startY=0;
    const addX = v => { v *= shapePathScale(width, path.width); left=Math.min(left,v); right=Math.max(right,v); };
    const addY = v => { v *= shapePathScale(height, path.height); top=Math.min(top,v); bottom=Math.max(bottom,v); };
    for (const c of path.points) {
      const op=c[0];
      if (op==='E') { addX(0); addX(path.width); addY(0); addY(path.height); }
      else if (op==='Z') { x=startX; y=startY; }
      else {
        if (op==='C' || op==='Q') {
          for (const v of bezierExtrema(op==='C' ? [x,c[1],c[3],c[5]] : [x,c[1],c[3]])) addX(v);
          for (const v of bezierExtrema(op==='C' ? [y,c[2],c[4],c[6]] : [y,c[2],c[4]])) addY(v);
        }
        x=c.at(-2); y=c.at(-1); addX(x); addY(y);
        if (op==='M') { startX=x; startY=y; }
      }
    }
  }
  return right>left && bottom>top ? { left, top, width:right-left, height:bottom-top } : null;
}

// Scene coordinates use EMUs; the preview symbol's pen and icon use CSS pixels.
function paintMissingPicture(ctx, image, x, y, width, height) {
  ctx.save(); ctx.scale(EMU_PER_PX, EMU_PER_PX);
  paintDecodedImage(ctx, image, x / EMU_PER_PX, y / EMU_PER_PX, width / EMU_PER_PX, height / EMU_PER_PX);
  ctx.restore();
}

// Render an immutable scene at the document's existing drawing size. The bitmap
// exists only in this session; export retains the vector and text source.
export async function decodeShape(asset, bitmaps, fontAlternatives, onRasterResize) {
  // Pictures carry their effects on the asset, standalone shapes on their scene.
  const effects = asset.effects || asset.scene.effects;
  const withShadow = asset.shadow ? raster => paintPictureShadow(raster, asset.shadow, asset.shadowGeometry) : null;
  if (asset.scene.type === 'picture3d') {
    const decoded = await decodePicture3d(asset, bitmaps);
    const painted = effects ? paintDrawingEffects(decoded, effects, withShadow) : withShadow ? withShadow(decoded) : decoded;
    // Effects use the fitted solid; page painting maps the result through the
    // original outer frame without stretching unused space in that frame.
    return { ...painted, frameWidth: asset.width, frameHeight: asset.height };
  }
  await loadCanvasFonts();
  const solidRectangles = supportsSolidRectangleDisplay(asset);
  const solidPlan = solidRectangles ? {} : undefined;
  const render = (asset, context, placement, scale = 2, display) => {
    const raster = rasterShape(asset, bitmaps, fontAlternatives, context, placement, scale, display, false, solidPlan);
    if (effects) return paintDrawingEffects(raster, effects, withShadow);
    return asset.shadow ? paintPictureShadow(raster, asset.shadow, asset.shadowGeometry) : raster;
  };
  const displaySupported = solidRectangles || supportsDrawingDisplay(asset);
  // Validate and reserve the baseline surface now; eligible scenes are painted
  // once their page position is known instead of painting a disposable baseline.
  const initial = displaySupported ? rasterShape(asset,bitmaps,fontAlternatives,undefined,undefined,2,undefined,true,solidPlan) : render(asset);
  const solidPaints = solidPlan?.rectangles;
  const hasFields = shapeHasFields(asset.scene), hasPatterns = shapeHasPatterns(asset.scene);
  // A drawing can appear on multiple pages or move during editing. Replace its
  // raster for changed fields/tile phase; retain one bitmap per source asset.
  let current = initial, key = JSON.stringify([null,undefined,asset.width,asset.height,2,undefined]);
  let solidPlacement;
  return { ...initial,
    ...(solidPaints ? {paintDisplay(ctx,x,y,width,height,context) {
      return paintSolidRectangleDisplay(ctx,solidPaints,x,y,width,height,asset.width,asset.height,context?.bitmapDisplayScale);
    }} : {}),
    get rasterPixelCount() { return current.bitmap ? current.bitmap.width*current.bitmap.height : current.rasterPixelCount; },
    get bitmap() { if (!current.bitmap) current=render(asset);return current.bitmap; },
    forPage(context, placement) {
    if (!context && !placement) { if (!current.bitmap) current=render(asset);return current; }
    if (solidRectangles && current.bitmap && placement && solidPlacement &&
      solidPlacement.screen === !!context?.bitmapDisplayScale &&
      solidPlacement.x===placement.x && solidPlacement.y===placement.y &&
      solidPlacement.width===placement.width && solidPlacement.height===placement.height &&
      solidPlacement.pixelRatio===placement.pixelRatio && solidPlacement.originX===placement.originX &&
      solidPlacement.originY===placement.originY && solidPlacement.axisAligned===placement.axisAligned) return current;
    // Resolve the physical frame before child rotation and text measurement.
    // Stretching the completed bitmap swaps these operations and scales ink.
    const frame = asset.relativeFrame && placement ? placement : asset;
    const patternPlacement = hasPatterns && placement ? {
      x: ((placement.x%8)+8)%8, y: ((placement.y%8)+8)%8,
      scaleX:frame.width ? placement.width/frame.width : 1, scaleY:frame.height ? placement.height/frame.height : 1,
    } : undefined;
    const frameScale = placement ? Math.max(frame.width ? placement.width/frame.width : 1,frame.height ? placement.height/frame.height : 1) : 1;
    const resolution = Math.max(2, Math.ceil((placement?.pixelRatio || 1)*frameScale));
    // Print canvas density is a sampling scale, not a screen zoom. Preserve
    // physical paths and pens rather than snapping them to device pixels.
    const projected=displaySupported && !context?.printing && (!solidRectangles || context?.bitmapDisplayScale) ? drawingDisplayPlacement(placement,frame) : undefined;
    const display=projected && solidRectangles ? {...projected,solidRectangles:true} : projected;
    // Screen endpoint coverage must not leak into a same-scale print raster.
    // Reuse the existing context key slot; warm paints need no extra object.
    const nextKey = JSON.stringify([hasFields ? context : projected && context?.bitmapDisplayScale ? true : null,patternPlacement,frame.width,frame.height,resolution,display]);
    if (key !== nextKey || !current.bitmap) {
      let scene=asset.scene;
      if (frame !== asset) {
        // Relative sizing can expand a flat line's collapsed axis. Its preset
        // uses a unit path grid, so assign the resolved physical frame directly
        // rather than dividing by the saved zero extent. Pens stay physical.
        scene=asset.scene.type === 'shape' && (!asset.scene.width || !asset.scene.height)
          ? {...asset.scene,width:frame.width*EMU_PER_PX,height:frame.height*EMU_PER_PX}
          : resizeShapeFrame(asset.scene,asset.width ? frame.width/asset.width : 1,asset.height ? frame.height/asset.height : 1);
        // A zero group axis has no resize ratio. The outer
        // selection frame can expand with percentages while keeping that artwork axis
        // collapsed (native zero-axis-group-relative controls).
      }
      const renderAsset = frame === asset ? asset : {...asset,width:frame.width,height:frame.height,scene};
      let next;
      try {
        next = render(renderAsset, context, patternPlacement, resolution, display);
        onRasterResize?.(current,next);
      } catch(error) {
        next?.close();
        if (resolution <= 2 && !display) throw error;
        // An optional display upgrade must not make a previously editable
        // document fail its session resource budget. Retain the baseline path.
        next = render(renderAsset, context, patternPlacement, 2);
        try { onRasterResize?.(current,next); } catch(error) { next.close(); throw error; }
      }
      current.close(); current = next; key = nextKey;
    }
    if (solidRectangles && placement) solidPlacement={...placement,screen:!!context?.bitmapDisplayScale};
    return current;
  }, close: () => current.close() };
}

function rasterShape(asset, bitmaps, fontAlternatives, fieldContext, patternPlacement, requestedScale = 2, display, measureOnly = false, solidPlan) {
  const measurement = solidPlan ? undefined : new OffscreenCanvas(1, 1).getContext('2d'), textLayouts = new Map(), tilePatterns = new Map();
  const collapsedChildren=new Map();
  const groupChildren=node => {
    if (node.width && node.height) return node.children;
    // Collapse local positions and dimensions before the child's rotation.
    // Reuse ephemeral frames between measurement and painting; retain the
    // immutable imported scene and its source geometry for export.
    if (!collapsedChildren.has(node)) collapsedChildren.set(node,node.children.map(child=>({
      ...child,...(!node.width ? {x:node.childX,width:0} : {}),
      ...(!node.height ? {y:node.childY,height:0} : {}),
    })));
    return collapsedChildren.get(node);
  };
  const shadowLayers = new Map();
  let solidMatrices = solidPlan ? new Map() : undefined;
  if (measurement) setCanvasFontAlternatives(measurement, fontAlternatives);
  const bounds = { left: 0, top: 0, right: asset.width, bottom: asset.height };
  const include = (x, y, w, h) => { bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y); bounds.right = Math.max(bounds.right, x + w); bounds.bottom = Math.max(bounds.bottom, y + h); };
  const prepare = (node, x, y, sx, sy, root = false, orientation) => {
    if (!root) { x += node.x * sx; y += node.y * sy; }
    if (solidMatrices && node.type === 'shape') solidMatrices.set(node,{a:sx,d:sy,e:x,f:y,grouped:asset.scene.type==='group'});
    if (node.type === 'group') {
      if (node.groupRotation || node.flipH || node.flipV) {
        const o = orientation || [1,0,0,1,0,0];
        const handedness=o[0]*o[3]-o[1]*o[2];
        const m = composeDrawingRotation(node, [o[0]*sx,o[1]*sx,o[2]*sy,o[3]*sy,o[0]*x+o[2]*y+o[4],o[1]*x+o[3]*y+o[5]], node.groupRotation || 0,handedness);
        if (node.flipH) { m[4] += m[0]*node.width; m[5] += m[1]*node.width; m[0] *= -1; m[1] *= -1; }
        if (node.flipV) { m[4] += m[2]*node.height; m[5] += m[3]*node.height; m[2] *= -1; m[3] *= -1; }
        sx = Math.hypot(m[0],m[1]); sy = Math.hypot(m[2],m[3]);
        orientation = drawingOrientation(m,handedness*(node.flipH ? -1 : 1)*(node.flipV ? -1 : 1));
        x = 0; y = 0;
      }
      sx *= drawingGroupScale(node.width, node.childWidth); sy *= drawingGroupScale(node.height, node.childHeight);
      for (const child of groupChildren(node)) prepare(child, x - node.childX * sx, y - node.childY * sy, sx, sy, false, orientation);
    } else if (orientation) {
      const [a,b,c,d,e,f] = orientation;
      let m = [a*sx,b*sx,c*sy,d*sy,a*x+c*y+e,b*x+d*y+f];
      const rotation = node.pictureRotation || node.shapeRotation;
      if (rotation) m = composeDrawingRotation(node,m,rotation,a*d-b*c);
      if (node.type === 'picture') {
        for (const px of [0,node.width]) for (const py of [0,node.height]) include(m[0]*px+m[2]*py+m[4],m[1]*px+m[3]*py+m[5],0,0);
      } else if (node.lineRotation) {
        const edge = outlinePadding(node.outline,false)/EMU_PER_PX;
        for (const [px,py] of rotatedLinePoints(node,sx,sy)) include(a*px+c*py+m[4]-edge,b*px+d*py+m[5]-edge,2*edge,2*edge);
      } else {
        const box = transformedShapeBounds(node,m);
        include(box.left,box.top,box.right-box.left,box.bottom-box.top);
      }
    } else if (node.type === 'picture') {
      if (node.pictureRotation) {
        const [a,b,c,d,e,f] = pictureRotationMatrix(node, sx, sy);
        for (const px of [0,node.width]) for (const py of [0,node.height]) include(x+a*px+c*py+e, y+b*px+d*py+f, 0, 0);
      } else include(x, y, node.width * sx, node.height * sy);
    }
    else if (node.shapeRotation) {
      const box = transformedShapeBounds(node, drawingRotationMatrix(node, sx, sy, node.shapeRotation));
      include(x + box.left, y + box.top, box.right - box.left, box.bottom - box.top);
    } else if (node.lineRotation) {
      const edge = outlinePadding(node.outline,false)/EMU_PER_PX;
      for (const [px, py] of rotatedLinePoints(node, sx, sy)) include(x + px - edge, y + py - edge, 2 * edge, 2 * edge);
    } else if (node.pictureOutline) {
      const box = transformedShapeBounds(node, [sx,0,0,sy,0,0]);
      include(x + box.left, y + box.top, box.right - box.left, box.bottom - box.top);
    } else {
      // A group transform does not clip children to the group's nominal frame.
      for (const path of node.paths) {
        const edge = path.stroke ? outlinePadding(node.outline,true,path) : 0;
        const edgeX = edge / EMU_PER_PX;
        const edgeY = edge / EMU_PER_PX;
        let currentX = 0, currentY = 0, startX = 0, startY = 0;
        const point = (px, py) => include(x + (node.flipH ? path.width - px : px) * shapePathScale(node.width, path.width) * sx - edgeX, y + (node.flipV ? path.height - py : py) * shapePathScale(node.height, path.height) * sy - edgeY, 2 * edgeX, 2 * edgeY);
        for (const command of path.points) {
          const [op, px, py] = command;
          if (op === 'E') include(x - edgeX, y - edgeY, node.width * sx + 2 * edgeX, node.height * sy + 2 * edgeY);
          else if (op === 'Z') { currentX = startX; currentY = startY; }
          else {
            const endX = command.at(-2), endY = command.at(-1);
            point(endX, endY);
            if (op === 'C' || op === 'Q') {
              for (const value of bezierExtrema(op === 'C' ? [currentX, px, command[3], endX] : [currentX, px, endX])) point(value, currentY);
              for (const value of bezierExtrema(op === 'C' ? [currentY, py, command[4], endY] : [currentY, py, endY])) point(currentX, value);
            }
            currentX = endX; currentY = endY;
            if (op === 'M') { startX = currentX; startY = currentY; }
          }
        }
      }
    }
    if (node.text) {
      const measure = (text, style) => measureCanvasText(measurement, text, style);
      const o=orientation || [1,0,0,1,0,0];
      let m=[o[0]*sx,o[1]*sx,o[2]*sy,o[3]*sy,o[0]*x+o[2]*y+o[4],o[1]*x+o[3]*y+o[5]];
      if(node.shapeRotation)m=composeDrawingRotation(node,m,node.shapeRotation,o[0]*o[3]-o[1]*o[2]);
      // Rotation can exchange the physical axes of an unequally scaled group.
      // Insets and glyph sizes stay physical, so measure in the resulting frame.
      let tx=Math.hypot(m[0],m[1]),ty=Math.hypot(m[2],m[3]),frame=node,upright;
      if(node.text.upright) {
        const angle=Math.round((((Math.atan2(m[1],m[0])*180/Math.PI)%360+360)%360)*1e9)/1e9;
        const swap=angle>=45&&angle<135||angle>=225&&angle<315;
        const w=node.width*tx,h=node.height*ty;
        const width=swap?h:w,height=swap?w:h;
        const cx=m[0]*node.width/2+m[2]*node.height/2+m[4],cy=m[1]*node.width/2+m[3]*node.height/2+m[5];
        upright={x:cx-width/2,y:cy-height/2,originX:m[4],originY:m[5]};
        frame={...node,width:width*EMU_PER_PX,height:height*EMU_PER_PX};
        tx=ty=1/EMU_PER_PX;
        include(upright.x,upright.y,width,height);
      } else if(node.shapeRotation||orientation) {
        for(const px of [0,node.width])for(const py of [0,node.height])include(m[0]*px+m[2]*py+m[4],m[1]*px+m[3]*py+m[5],0,0);
      }
      const text = layoutShapeText(frame, measure, { x: tx * EMU_PER_PX, y: ty * EMU_PER_PX }, fieldContext);
      textLayouts.set(node, { ...text, sx:tx, sy:ty, upright });
    }
    if (node.shadow) {
      // A picture effect composites its texture, backing and outline together.
      // Its retained geometry supplies bounds even when those paints form a group.
      const caster = node.shadowGeometry ? { ...node.shadowGeometry, width: node.width, height: node.height } : node;
      const o = orientation || [1,0,0,1,0,0];
      let m = [o[0]*sx,o[1]*sx,o[2]*sy,o[3]*sy,o[0]*x+o[2]*y+o[4],o[1]*x+o[3]*y+o[5]];
      if (caster.shapeRotation) m = composeDrawingRotation(caster,m,caster.shapeRotation,o[0]*o[3]-o[1]*o[2]);
      const box = transformedShapeBounds(caster,m);
      // Retain room for text in custom geometry whose paths do not cover its
      // entire text frame. Effects never alter that frame or document layout.
      if (node.text) for (const px of [0,node.width]) for (const py of [0,node.height]) {
        const tx=m[0]*px+m[2]*py+m[4],ty=m[1]*px+m[3]*py+m[5];
        box.left=Math.min(box.left,tx);box.right=Math.max(box.right,tx);
        box.top=Math.min(box.top,ty);box.bottom=Math.max(box.bottom,ty);
      }
      // A suppressed/empty custom path has no silhouette to cast a shadow.
      if (!Number.isFinite(box.left)) return;
      const fx=caster.flipH?-1:1,fy=caster.flipV?-1:1;
      const unit=drawingOrientation(m,o[0]*o[3]-o[1]*o[2]);
      const basis = node.shadow.rotateWithShape ? [fx*(sx ? m[0]/sx : unit[0]),fx*(sx ? m[1]/sx : unit[1]),fy*(sy ? m[2]/sy : unit[2]),fy*(sy ? m[3]/sy : unit[3])] : [1,0,0,1];
      const shadow = {...node.shadow,x:basis[0]*node.shadow.x+basis[2]*node.shadow.y,y:basis[1]*node.shadow.x+basis[3]*node.shadow.y};
      const layer={left:Math.floor(box.left),top:Math.floor(box.top),right:Math.ceil(box.right),bottom:Math.ceil(box.bottom),shadow};
      shadowLayers.set(node,layer);
      const pad=shadow.blur+1;
      include(layer.left+shadow.x-pad,layer.top+shadow.y-pad,layer.right-layer.left+2*pad,layer.bottom-layer.top+2*pad);
    }
  };
  // Flat standalone lines have one zero frame/shape extent. The nonzero axis
  // defines their scale without inventing layout space on the collapsed axis.
  // A group's own extent is physical, even when the saved outer wp:extent
  // disagrees. That outer extent is still the relative-size/layout basis.
  const sx = asset.scene.type === 'group' || !asset.scene.width && !asset.scene.height ? 1 / EMU_PER_PX : asset.scene.width ? asset.width / asset.scene.width : asset.height / asset.scene.height;
  const sy = asset.scene.type === 'group' || !asset.scene.width && !asset.scene.height ? 1 / EMU_PER_PX : asset.scene.height ? asset.height / asset.scene.height : asset.width / asset.scene.width;
  if (solidPlan?.scene===asset.scene && solidPlan.width===asset.width && solidPlan.height===asset.height) {
    Object.assign(bounds,solidPlan.bounds);solidMatrices=solidPlan.matrices;
  } else {
    prepare(asset.scene, 0, 0, sx, sy, true);
    if (solidPlan) Object.assign(solidPlan,{scene:asset.scene,width:asset.width,height:asset.height,bounds:{...bounds},matrices:solidMatrices,
      rectangles:asset.scene.type==='shape'?solidRectanglePaints(solidMatrices):undefined});
  }
  const baseLeft=Math.floor(bounds.left),baseTop=Math.floor(bounds.top);
  const base={left:baseLeft,top:baseTop,width:Math.ceil(bounds.right)-baseLeft,height:Math.ceil(bounds.bottom)-baseTop};
  if (base.width > 4096 || base.height > 4096 || base.width * base.height > 4000000) throw new Error('This drawing preview exceeds the image resource limit.');
  const surface=display && drawingDisplaySurface(bounds,display);
  if (!surface) display=undefined;
  const {left,top,width,height}=surface || base;
  const resolution=surface?.resolution ?? drawingRasterScale(width,height,requestedScale);
  const pixelsWide=surface?.pixelsWide ?? Math.max(1,width*resolution),pixelsHigh=surface?.pixelsHigh ?? Math.max(1,height*resolution);
  if (measureOnly) return {left,top,width,height,frameWidth:asset.width,frameHeight:asset.height,rasterScale:resolution,rasterPixelCount:pixelsWide*pixelsHigh,close(){}};
  const canvas = new OffscreenCanvas(pixelsWide,pixelsHigh);
  let ctx = canvas.getContext('2d');
  let paintCompound;
  let paintMarked;
  const markedStroke = (outline,ends,build) => {
    paintMarked ||= markedOutlinePainter(canvas.width,canvas.height);
    paintMarked(ctx,outline.color,ink=>{
      ink.beginPath();build(ink);ink.setTransform(resolution,0,0,resolution,0,0);
      ink.strokeStyle='#000';ink.lineWidth=outline.width/EMU_PER_PX;
      ink.lineCap={flat:'butt',rnd:'round',sq:'square'}[outline.cap || 'flat'];
      ink.lineJoin=outline.join || 'round';ink.miterLimit=outline.miterLimit || 10;
      ink.setLineDash(drawingLineDash(outline.dash,outline.cap).map(n=>n*ink.lineWidth));ink.stroke();
      trimLineEnds(ink,outline,ends,resolution/EMU_PER_PX);
      paintLineEnds(ink,{...outline,color:'#000'},ends,resolution/EMU_PER_PX);
    });
  };
  setCanvasFontAlternatives(ctx, fontAlternatives);
  ctx.scale(resolution, resolution); ctx.translate(-left, -top); ctx.scale(sx, sy);
  const rotate = (node, angle, handedness) => {
    const m = ctx.getTransform();
    ctx.setTransform(...composeDrawingRotation(node,[m.a,m.b,m.c,m.d,m.e,m.f],angle,handedness));
  };
  const reflect = (width,height,flipH,flipV) => {
    if (!flipH && !flipV) return;
    const m=ctx.getTransform(),x=flipH ? width : 0,y=flipV ? height : 0;
    const sx=flipH ? -1 : 1,sy=flipV ? -1 : 1;
    // Compose translation with the matrix directly: Canvas translate() can
    // drop even a surviving-axis offset once the other axis is singular.
    ctx.setTransform(m.a*sx,m.b*sx,m.c*sy,m.d*sy,m.e+m.a*x+m.c*y,m.f+m.b*x+m.d*y);
  };
  const paint = (node, root = false, withoutShadow = false, handedness = 1) => {
    ctx.save(); if (!root) ctx.translate(node.x, node.y);
    if (node.shadow && !withoutShadow && shadowLayers.has(node)) {
      const layer=shadowLayers.get(node),w=Math.max(1,layer.right-layer.left),h=Math.max(1,layer.bottom-layer.top);
      const surface=new OffscreenCanvas(w*resolution,h*resolution),parent=ctx,m=parent.getTransform();
      ctx=surface.getContext('2d');setCanvasFontAlternatives(ctx,fontAlternatives);
      ctx.setTransform(m.a,m.b,m.c,m.d,m.e+resolution*(left-layer.left),m.f+resolution*(top-layer.top));
      try { paint(node,true,true,handedness); } finally {ctx=parent;}
      const bitmap=surface.transferToImageBitmap();
      const painted=paintPictureShadow({bitmap,left:0,top:0,width:w,height:h,frameWidth:w,frameHeight:h,rasterScale:resolution,close:()=>bitmap.close()},layer.shadow);
      try {
        ctx.resetTransform();ctx.drawImage(painted.bitmap,resolution*(layer.left+painted.left-left),resolution*(layer.top+painted.top-top),painted.width*resolution,painted.height*resolution);
      } finally {painted.close();ctx.restore();}
      return;
    }
    if (node.type === 'group') {
      if (node.groupRotation) rotate(node,node.groupRotation,handedness);
      if (node.flipH || node.flipV) {
        reflect(node.width,node.height,node.flipH,node.flipV);
        handedness *= (node.flipH ? -1 : 1)*(node.flipV ? -1 : 1);
      }
      const gx=drawingGroupScale(node.width,node.childWidth), gy=drawingGroupScale(node.height,node.childHeight);
      const m=ctx.getTransform();
      if (!gx || !gy || m.a*m.d-m.b*m.c === 0) {
        // Canvas translations after a singular scale can be ignored. Compose
        // each child's origin explicitly so the surviving axis keeps offsets.
        for (const child of groupChildren(node)) {
          const x=(child.x-node.childX)*gx, y=(child.y-node.childY)*gy;
          ctx.save();
          ctx.setTransform(m.a*gx,m.b*gx,m.c*gy,m.d*gy,m.e+m.a*x+m.c*y,m.f+m.b*x+m.d*y);
          paint(child,true,false,handedness);ctx.restore();
        }
      } else {
        ctx.scale(gx,gy);ctx.translate(-node.childX,-node.childY);
        for (const child of groupChildren(node)) paint(child,false,false,handedness);
      }
    } else if (node.type === 'picture') {
      if (node.pictureRotation) {
        rotate(node,node.pictureRotation,handedness);
      }
      const bitmap = bitmaps.get(node.image.assetId); if (!bitmap) throw new Error('A grouped picture could not be decoded.');
      const rect = imageCropRect(bitmap.previewPlaceholder ? undefined : node.image.crop, bitmap.width, bitmap.height);
      const bounds = node.clipPaths ? pictureGeometryBounds(node.clipPaths, node.width, node.height) : { left:0, top:0, width:node.width, height:node.height };
      if (rect && bounds) {
        ctx.globalAlpha *= node.image.opacity ?? 1;
        // Reflect the cropped picture about its frame, before ancestor group
        // scaling. Transparent crop outsets reflect with the image content.
        reflect(node.width,node.height,node.image.flipH,node.image.flipV);
        const [x,y,w,h] = rect.destination;
        const destination = [bounds.left+x*bounds.width, bounds.top+y*bounds.height, w*bounds.width, h*bounds.height];
        const paths = node.clipPaths?.filter(path => path.fill);
        if (paths) {
          // Each path paints separately with a shared texture mapping.
          // Winding cancellation is local to one path; translucent overlaps
          // accumulate opacity across paths.
          for (const path of paths) {
            ctx.save(); ctx.beginPath(); appendPath(ctx, path, node.width, node.height); ctx.clip();
            if (bitmap.previewPlaceholder) paintMissingPicture(ctx, bitmap, ...destination);
            else paintImage(ctx, bitmap, ...rect.source, ...destination);
            ctx.restore();
          }
        } else {
          if (bitmap.previewPlaceholder) paintMissingPicture(ctx, bitmap, ...destination);
          else paintImage(ctx, bitmap, ...rect.source, ...destination);
        }
      }
    } else if (node.lineRotation) {
      const matrix = ctx.getTransform();
      const scaleX = Math.hypot(matrix.a,matrix.b), scaleY = Math.hypot(matrix.c,matrix.d);
      const [a,b,c,d]=drawingOrientation([matrix.a,matrix.b,matrix.c,matrix.d],handedness);
      const points = rotatedLinePoints(node, scaleX / resolution, scaleY / resolution);
      ctx.setTransform(resolution, 0, 0, resolution, 0, 0);
      ctx.beginPath();
      points.forEach(([x, y], i) => ctx[i ? 'lineTo' : 'moveTo'](matrix.e / resolution + a*x + c*y, matrix.f / resolution + b*x + d*y));
      if (node.outline) {
        ctx.strokeStyle = node.outline.color;
        ctx.lineWidth = node.outline.width / EMU_PER_PX;
        ctx.lineCap = { flat: 'butt', rnd: 'round', sq: 'square' }[node.outline.cap || 'flat'];
        ctx.setLineDash(drawingLineDash(node.outline.dash, node.outline.cap).map(length => length * ctx.lineWidth));
        if (node.outline.compound) {
          const physical=points.map(([x,y])=>[matrix.e+resolution*(a*x+c*y),matrix.f+resolution*(b*x+d*y)]);
          const dashed=new Path2D();dashed.moveTo(...physical[0]);dashed.lineTo(...physical[1]);
          paintCompound ||= compoundOutlinePainter(canvas.width,canvas.height);
          paintCompound(ctx,new Path2D(),node.outline,resolution*node.outline.width/EMU_PER_PX,dashed,
            [{points:physical,direction:handedness*(node.flipH ? -1 : 1)*(node.flipV ? -1 : 1)}]);
        } else if (node.outline.headEnd || node.outline.tailEnd) {
          const physical=points.map(([x,y])=>[matrix.e+resolution*(a*x+c*y),matrix.f+resolution*(b*x+d*y)]);
          const vector=[physical[1][0]-physical[0][0],physical[1][1]-physical[0][1]];
          markedStroke(node.outline,vector[0] || vector[1] ? [{head:{point:physical[0],vector},tail:{point:physical[1],vector}}] : [],ink=>{
            ink.resetTransform();ink.moveTo(...physical[0]);ink.lineTo(...physical[1]);
          });
        } else ctx.stroke();
      }
    } else {
      if (node.shapeRotation) {
        rotate(node,node.shapeRotation,handedness);
      }
      // A nonrotating stretched texture occupies the upright bounds of the
      // transformed filled geometry. Rotation/reflection still applies to its
      // clip and outline; neither operation is inherited by the picture fill.
      let uprightFill;
      if (node.fill?.image?.rotateWithShape === false && !node.fill.tile) {
        const m = ctx.getTransform();
        uprightFill = transformedShapeBounds({ ...node, outline: null,
          paths: node.paths.filter(path => path.fill) }, [m.a,m.b,m.c,m.d,m.e,m.f]);
      }
      ctx.save();
      reflect(node.width,node.height,node.flipH,node.flipV);
      for (const path of node.paths) {
        ctx.beginPath();
        appendPath(ctx, path, node.width, node.height);
        // An explicit viewport collapses with its frame. Omitted viewport
        // dimensions instead preserve absolute custom-path coordinates.
        if (node.fill && path.fill && (node.width || !path.width) && (node.height || !path.height)) {
          const darken = path.fillMode === 'darkenLess';
          // Native darkenLess scales encoded RGB by 205/255, preserving alpha.
          // Filter only this fill, so gradients/patterns/pictures share the
          // rule while outlines, text and ordinary paths retain their paint.
          if (darken) { ctx.save(); ctx.filter = `brightness(${205/255})`; }
          if (typeof node.fill === 'string') {
            ctx.fillStyle = node.fill;
            if (display) {
              const pen=node.outline ? Math.max(1,Math.round(node.outline.width/EMU_PER_PX*display.scale)) : 0;
              const projected=display.solidRectangles
                ? projectedSolidRectangle(path,node.width,node.height,solidMatrices.get(node),display,resolution,left,top)
                : projectedDrawingPath(path,node.width,node.height,ctx.getTransform(),pen,display,resolution,appendPath);
              ctx.save();ctx.resetTransform();ctx.fill(projected);ctx.restore();
            } else ctx.fill();
          }
          else if (node.fill.type === 'circularGradient') { ctx.fillStyle = canvasCircularGradient(ctx, node.fill, node.width, node.height); ctx.fill(); }
          else if (node.fill.type === 'linearGradient') { ctx.fillStyle = canvasLinearGradient(ctx, node.fill, node.width, node.height); ctx.fill(); }
          else if (node.fill.type === 'pattern') {
            ctx.save(); ctx.imageSmoothingEnabled = false;
            ctx.fillStyle = canvasPatternFill(ctx,node.fill,{left,top,resolution,...patternPlacement}); ctx.fill(); ctx.restore();
          }
          else {
            const bitmap = bitmaps.get(node.fill.image.assetId);
            if (!bitmap) throw new Error('A shape picture fill could not be decoded.');
            if (bitmap.previewPlaceholder) {
              ctx.save(); ctx.clip();
              paintMissingPicture(ctx, bitmap, 0, 0, node.width, node.height);
              ctx.restore();
            } else if (node.fill.tile) {
              if (!tilePatterns.has(node.fill)) tilePatterns.set(node.fill, pictureTilePattern(ctx, node.fill, node.width, node.height, bitmap));
              const pattern = tilePatterns.get(node.fill);
              if (pattern) { ctx.save(); ctx.globalAlpha *= node.fill.image.opacity ?? 1; ctx.fillStyle = pattern; ctx.fill(); ctx.restore(); }
            } else {
              const rect = pictureFillRect(node.fill,
                uprightFill ? uprightFill.right-uprightFill.left : node.width,
                uprightFill ? uprightFill.bottom-uprightFill.top : node.height,
                bitmap.width, bitmap.height);
              if (rect) {
                ctx.save(); ctx.clip(); ctx.globalAlpha *= node.fill.image.opacity ?? 1;
                if (uprightFill) { ctx.resetTransform(); ctx.translate(uprightFill.left,uprightFill.top); }
                paintImage(ctx, bitmap, ...rect.source, ...rect.destination); ctx.restore();
              }
            }
          }
          if (darken) ctx.restore();
        }
        if (node.outline && path.stroke) {
          if (node.pictureOutline) {
            const pen = resolution * node.outline.width / EMU_PER_PX, physical = new Path2D();
            const offsetPen = resolution * (node.outline.declaredWidth ?? node.outline.width) / EMU_PER_PX;
            for (const points of pictureOutlineContours(path, node.width, node.height, ctx.getTransform(), resolution*4/3, offsetPen)) {
              if (!points.length) continue;
              physical.moveTo(...points[0]); for (const point of points.slice(1)) physical.lineTo(...point);
              physical.closePath();
            }
            if (node.outline.compound) {
              paintCompound ||= compoundOutlinePainter(canvas.width, canvas.height);
              paintCompound(ctx, physical, node.outline, pen);
            } else {
              ctx.save(); ctx.resetTransform(); ctx.strokeStyle = node.outline.color; ctx.lineWidth = pen;
              ctx.lineCap = { flat: 'butt', rnd: 'round', sq: 'square' }[node.outline.cap || 'flat'];
              ctx.lineJoin = node.outline.join || 'round'; ctx.miterLimit = node.outline.miterLimit || 10;
              ctx.setLineDash(drawingLineDash(node.outline.dash, node.outline.cap).map(n => n * pen));
              ctx.stroke(physical); ctx.restore();
            }
            continue;
          }
          if (node.outline.compound) {
            const physical = new Path2D(), dashed = new Path2D(), open=[];
            for (const contour of compoundContours(path,node.width,node.height,ctx.getTransform(),resolution*4/3)) {
              const {points,closed}=contour;
              if (!points.length) continue;
              for (const p of closed ? [physical,dashed] : [dashed]) {
                p.moveTo(...points[0]);for(const point of points.slice(1))p.lineTo(...point);
                if (closed) p.lineTo(...points[0]);
              }
              if (closed) physical.closePath(); else open.push(contour);
            }
            paintCompound ||= compoundOutlinePainter(canvas.width, canvas.height);
            paintCompound(ctx, physical, node.outline, resolution * node.outline.width / EMU_PER_PX, dashed, open);
            continue;
          }
          // Path coordinates are already transformed. Shape
          // pen width stays in physical units even inside anisotropically scaled groups.
          const ends = node.outline.headEnd || node.outline.tailEnd ? pathLineEnds(path,node.width,node.height,ctx.getTransform(),node.outline,resolution/EMU_PER_PX) : null;
          if (ends?.length) {
            const matrix=ctx.getTransform();
            markedStroke(node.outline,ends,ink=>{ink.setTransform(matrix);appendPath(ink,path,node.width,node.height);});
            continue;
          }
          const point = node.outline.cap === 'rnd' && !node.outline.dash
            ? pointOutlinePosition(path, node.width, node.height) : null;
          if (point) {
            const m = ctx.getTransform();
            ctx.save(); ctx.resetTransform(); ctx.beginPath();
            ctx.arc(m.a * point[0] + m.c * point[1] + m.e, m.b * point[0] + m.d * point[1] + m.f,
              resolution * node.outline.width / EMU_PER_PX / 2, 0, 2 * Math.PI);
            ctx.fillStyle = node.outline.color; ctx.fill(); ctx.restore();
            continue;
          }
          const screenPen=display ? Math.max(1,Math.round(node.outline.width/EMU_PER_PX*display.scale)) : null;
          const projected=display ? projectedDrawingPath(path,node.width,node.height,ctx.getTransform(),screenPen,display,resolution,appendPath) : null;
          ctx.save(); ctx.setTransform(display ? 1 : resolution, 0, 0, display ? 1 : resolution, 0, 0);
          ctx.strokeStyle = node.outline.color;
          ctx.lineWidth = display ? screenPen*resolution/display.scale : node.outline.width / EMU_PER_PX;
          ctx.lineCap = { flat: 'butt', rnd: 'round', sq: 'square' }[node.outline.cap || 'flat'];
          ctx.setLineDash(drawingLineDash(node.outline.dash, node.outline.cap).map(length => length * node.outline.width/EMU_PER_PX * (display ? resolution : 1)));
          ctx.lineJoin = node.outline.join || 'round'; ctx.miterLimit = node.outline.miterLimit || 10;
          if (projected) ctx.stroke(projected);else ctx.stroke();ctx.restore();
        }
      }
      ctx.restore();
      if (node.text) {
        // Horizontal-flip text stays upright and vertical-flip text rotates
        // 180 degrees, rather than mirroring its glyphs.
        const text=textLayouts.get(node);
        if (text.upright) {
          const m=ctx.getTransform(),u=text.upright;
          // Preserve the current surface offset, including shadow-layer crops.
          ctx.setTransform(resolution,0,0,resolution,m.e+resolution*(u.x-u.originX),m.f+resolution*(u.y-u.originY));
        }
        else {
          // Group reflection relocates the frame but never mirrors its text.
          // Removing a mirrored local x axis leaves vertical reflection as a
          // half turn, including composed/nested group orientations.
          if (handedness < 0) reflect(node.width, node.height, true, false);
          if (node.flipV) { ctx.translate(node.width, node.height); ctx.rotate(Math.PI); }
        }
        const { layout, shift, left: textLeft, top: textTop, clip, sx, sy } = text;
        // The current origin is already in the transformed shape. Cancel only
        // the scene's coordinate scale, retaining bitmap resolution and origin.
        if(!text.upright)ctx.scale(1 / sx, 1 / sy);
        ctx.beginPath(); ctx.rect(clip.left, clip.top, clip.width, clip.height); ctx.clip();
        ctx.translate(textLeft, textTop + shift); ctx.textBaseline = 'alphabetic';
        for (const cell of layout.cells) if (cell.fill) {
          const top = Math.max(cell.y - (cell.borderInsets?.top || 0) + (cell.fillTopInset || 0), cell.cellClip?.top ?? -Infinity);
          const bottom = Math.min(cell.y + cell.height - (cell.borderInsets?.bottom || 0) - (cell.fillBottomInset || 0), cell.cellClip?.bottom ?? Infinity);
          const left = Math.max(cell.x, cell.cellClip?.left ?? -Infinity), right = Math.min(cell.x + cell.width, cell.cellClip?.right ?? Infinity);
          ctx.fillStyle = cell.fill;
          if (bottom > top && right > left) ctx.fillRect(left, top, right - left, bottom - top);
        }
        // Table guides belong to editable cells, not a retained drawing's ink.
        for (const stroke of layout.tableBorders) if (!stroke.guide) paintTableBorder(ctx, stroke);
        // Text boxes allow exact-spaced lines to overlap; only the frame
        // clips their ink (unlike exact-spaced body paragraphs).
        for (const line of layout.lines) for (const fragment of line.fragments) {
          ctx.save();
          if (line.cellClip) {
            const c = line.cellClip, x = c.left ?? clip.left - left, right = c.right ?? clip.left + clip.width - left;
            ctx.beginPath(); ctx.rect(x, c.top, right - x, c.bottom - c.top); ctx.clip();
          }
          if (fragment.image) {
            const bitmap = bitmaps.get(fragment.image.assetId);
            if (!bitmap) throw new Error('A text box picture could not be decoded.');
            const { image } = fragment;
            const frame = inlineImagePaintFrame(image, fragment.x, line.baseline - fragment.ascent);
            const angle = normalizedRotation(image.rotation), transformed = angle || image.flipH || image.flipV;
            // Pictures use physical inline units, like the surrounding text;
            // ancestor group scale has already been removed above.
            if (transformed) {
              ctx.translate(frame.x + frame.width / 2, frame.y + frame.height / 2);
              ctx.rotate(angle / ANGLE_PER_DEGREE * Math.PI / 180);
              ctx.scale(image.flipH ? -1 : 1, image.flipV ? -1 : 1);
            }
            const x = transformed ? -frame.width / 2 : frame.x, y = transformed ? -frame.height / 2 : frame.y;
            ctx.globalAlpha *= image.opacity ?? 1;
            if (bitmap.previewPlaceholder || !image.crop || !Object.values(image.crop).some(Boolean)) paintDecodedImage(ctx, bitmap, x, y, frame.width, frame.height, fieldContext);
            else {
              const rect = imageCropRect(image.crop, bitmap.width, bitmap.height);
              if (rect) { const [left, top, width, height] = rect.destination; paintImage(ctx, bitmap, ...rect.source, x + left * frame.width, y + top * frame.height, width * frame.width, height * frame.height); }
            }
            ctx.restore(); continue;
          }
          setCanvasTextStyle(ctx, fragment);
          paintTextShadows(ctx, fragment, line.baseline);
          const colors = fragment.colors || [{ value: fragment.color }];
          for (let i = 0; i < colors.length; i++) {
            const span = colors[i]; ctx.save();
            // Without a fontRef color, automatic shape text contrasts with
            // an opaque solid fill. Other fills retain the existing backdrop.
            const background = typeof node.fill === 'string' && /^#[\da-f]{6}$/i.test(node.fill) ? node.fill : '#ffffff';
            ctx.fillStyle = paintColor(span.value, background);
            if (colors.length > 1) {
              const start = i === 0 ? clip.left - left : fragment.x + span.x;
              const end = i === colors.length - 1 ? clip.left + clip.width - left : fragment.x + span.x + span.width;
              ctx.beginPath(); ctx.rect(start, clip.top - top - shift, end - start, clip.height); ctx.clip();
            }
            paintText(ctx, Object.hasOwn(span, 'textOutline') ? { ...fragment, textOutline: span.textOutline, textFill: span.textFill ?? null, text3d: span.text3d ?? null, textScene: span.textScene ?? null } : fragment, line.baseline);
            ctx.restore();
          }
          ctx.restore();
        }
      }
    }
    ctx.restore();
  };
  paint(asset.scene, true);
  const bitmap = canvas.transferToImageBitmap();
  // Bilinear reduction can miss a subpixel table rule entirely at some page
  // offsets. Area filtering retains its coverage without widening authored ink.
  const tableText = [...textLayouts.values()].some(t => t.layout.cells.length);
  return { bitmap, left, top, frameWidth: asset.width, frameHeight: asset.height, width, height, rasterScale:resolution, ...(tableText ? { smoothingQuality: 'high' } : {}), close: () => bitmap.close() };
}
