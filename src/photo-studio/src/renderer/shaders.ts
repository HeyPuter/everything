// Both backends use straight-alpha sources and identical source-over blend math.
export const glVertex = `#version 300 es
precision highp float;
out vec2 uv;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));uv=p;gl_Position=vec4(p*2.-1.,0,1);}`;
function glShader(highPrecision: boolean, associated: boolean) {
  return `#version 300 es
precision highp float;
const bool highPrecision = ${highPrecision};
const bool associated = ${associated};
in vec2 uv;out vec4 outColor;
uniform sampler2D backTex;uniform sampler2D imageTex;uniform sampler2D maskTex;uniform sampler2D pixelMaskTex;uniform vec4 u[24];
// Sources stay straight RGBA for editing/readback. Resampling must average
// associated color contributions: hidden RGB has no visible contribution.
// https://graphics.stanford.edu/courses/cs148-08/lectures/imaging/imaging.pdf
// Normalize alpha weights before mixing RGB to avoid multiplying tiny coverage
// into HDR color. Equal coverage retains the existing opaque interpolation.
// Float filtering is optional; hardware linear filtering of straight byte
// textures also mixes hidden RGB. Keep masks/basis channels unassociated.
vec4 sampleTexel(sampler2D tex,vec2 pixel,bool color){
 ivec2 size=textureSize(tex,0);vec2 at=clamp(pixel,vec2(0),vec2(size))-.5;
 ivec2 base=ivec2(floor(at));vec2 f=fract(at);ivec2 hi=size-1;
 vec4 a=texelFetch(tex,clamp(base,ivec2(0),hi),0);
 // An exact center is a copy, including subnormal samples and signed zero.
 if(all(equal(f,vec2(0))))return a;
 vec4 b=texelFetch(tex,clamp(base+ivec2(1,0),ivec2(0),hi),0);
 vec4 c=texelFetch(tex,clamp(base+ivec2(0,1),ivec2(0),hi),0);
 vec4 d=texelFetch(tex,clamp(base+ivec2(1),ivec2(0),hi),0);
 if(associated && color && !(a.a==b.a && a.a==c.a && a.a==d.a)){
  vec4 alpha=vec4(a.a,b.a,c.a,d.a);
  vec4 weight=vec4((1.-f.x)*(1.-f.y),f.x*(1.-f.y),(1.-f.x)*f.y,f.x*f.y);
  float coverage=dot(alpha,weight);
  float scale=max(max(a.a,b.a),max(c.a,d.a));
  weight*=alpha/scale;float total=dot(weight,vec4(1));
  if(total>0.){weight/=total;return vec4(a.rgb*weight.x+b.rgb*weight.y+c.rgb*weight.z+d.rgb*weight.w,coverage);}
 }
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
vec4 sampleAt(sampler2D tex,vec2 pixel){return sampleTexel(tex,pixel,false);}
vec4 sampleColorAt(sampler2D tex,vec2 pixel){return sampleTexel(tex,pixel,true);}
vec4 samplePixel(sampler2D tex,vec2 p){if(!highPrecision)return texture(tex,p);return sampleAt(tex,p*vec2(textureSize(tex,0)));}
vec4 source(vec2 p){return samplePixel(imageTex,clamp(p,vec2(0),vec2(1)));}
float maskTap(ivec2 p){ivec2 size=textureSize(pixelMaskTex,0);if(any(lessThan(p,ivec2(0)))||any(greaterThanEqual(p,size)))return u[10].z;return texelFetch(pixelMaskTex,p,0).r;}
float pixelMaskAt(vec2 world){
 if(u[11].z<.5)return u[10].z;
 vec2 at=vec2(dot(world,u[9].xz),dot(world,u[9].yw))+u[10].xy-.5;
 ivec2 p=ivec2(floor(at));vec2 f=fract(at);float a=maskTap(p);
 if(all(equal(f,vec2(0))))return a;
 return mix(mix(a,maskTap(p+ivec2(1,0)),f.x),mix(maskTap(p+ivec2(0,1)),maskTap(p+ivec2(1)),f.x),f.y);
}
float blendLum(vec3 c){return dot(c,vec3(.3,.59,.11));}
vec3 clipColor(vec3 c){float l=blendLum(c);float n=min(min(c.r,c.g),c.b);float x=max(max(c.r,c.g),c.b);if(n<0.)c=l+(c-l)*l/max(l-n,1e-6);if(x>1.)c=l+(c-l)*(1.-l)/max(x-l,1e-6);return c;}
vec3 setLum(vec3 c,float l){return clipColor(c+(l-blendLum(c)));}
float blendSat(vec3 c){return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
vec3 setSat(vec3 c,float s){float mx=max(max(c.r,c.g),c.b),mn=min(min(c.r,c.g),c.b);return mx>mn?(c-mn)*s/(mx-mn):vec3(0);}
float burn(float b,float s){return b>=1.?1.:s<=0.?0.:1.-min(1.,(1.-b)/s);}
float dodge(float b,float s){return b<=0.?0.:s>=1.?1.:min(1.,b/(1.-s));}
float sepBlend(int m,float b,float s){
 if(m==2)return min(b,s);if(m==3)return b*s;if(m==4)return burn(b,s);if(m==5)return max(b+s-1.,0.);
 if(m==7)return max(b,s);if(m==8)return b+s-b*s;if(m==9)return dodge(b,s);if(m==10)return min(b+s,1.);
 if(m==12)return b<=.5?2.*b*s:1.-2.*(1.-b)*(1.-s);
 if(m==13){if(s<=.5)return b-(1.-2.*s)*b*(1.-b);float d=b<=.25?((16.*b-12.)*b+4.)*b:sqrt(b);return b+(2.*s-1.)*(d-b);}
 if(m==14)return s<=.5?2.*b*s:1.-2.*(1.-b)*(1.-s);
 if(m==15)return s<=.5?burn(b,2.*s):dodge(b,2.*s-1.);
 if(m==16)return clamp(b+2.*s-1.,0.,1.);
 if(m==17)return s<=.5?min(b,2.*s):max(b,2.*s-1.);
 if(m==18)return b+s>=1.?1.:0.;
 if(m==19)return abs(b-s);if(m==20)return b+s-2.*b*s;if(m==21)return max(b-s,0.);
 if(m==22)return s<=0.?(b<=0.?0.:1.):min(b/s,1.);
 return s;
}
// Mode indices follow the blends array in model/document.ts. Darker and
// Lighter Color ties keep the source, as in imaging/blend/modes.ts.
vec3 blendMode(int m,vec3 b,vec3 s){
 if(m<=1)return s;
 if(m==6)return blendLum(b)<blendLum(s)?b:s;if(m==11)return blendLum(b)>blendLum(s)?b:s;
 if(m==23)return setLum(setSat(s,blendSat(b)),blendLum(b));if(m==24)return setLum(setSat(b,blendSat(s)),blendLum(b));
 if(m==25)return setLum(s,blendLum(b));if(m==26)return setLum(b,blendLum(s));
 return vec3(sepBlend(m,b.r,s.r),sepBlend(m,b.g,s.g),sepBlend(m,b.b,s.b));
}
// Dissolve keeps a stable per-pixel pattern so edits do not shimmer.
float dissolveNoise(vec2 p){return fract(sin(dot(floor(p),vec2(12.9898,78.233)))*43758.5453);}
// Blend If (model/blending.ts): ranges in levels for gray and each color
// channel of this layer (u[12], u[14], …) and of the underlying pixels.
float rangeWeight(float v,vec4 r){float lo=r.y>r.x?clamp((v-r.x)/(r.y-r.x),0.,1.):(v>=r.x?1.:0.);float hi=r.w>r.z?clamp((r.w-v)/(r.w-r.z),0.,1.):(v<=r.w?1.:0.);return lo*hi;}
float toLevel(float c){return floor(clamp(c,0.,1.)*255.+.5);}
float blendIf(vec3 s,vec3 b){
 float w=rangeWeight(toLevel(blendLum(s)),u[12])*rangeWeight(toLevel(blendLum(b)),u[13]);
 w*=rangeWeight(toLevel(s.r),u[14])*rangeWeight(toLevel(b.r),u[15]);
 w*=rangeWeight(toLevel(s.g),u[16])*rangeWeight(toLevel(b.g),u[17]);
 return w*rangeWeight(toLevel(s.b),u[18])*rangeWeight(toLevel(b.b),u[19]);
}
void main(){
 vec2 q=vec2(uv.x,u[7].z>.5?uv.y:1.-uv.y);
 vec2 pixel=gl_FragCoord.xy;if(u[7].z<.5)pixel.y=u[6].w-pixel.y;
 if(u[7].w>0.5){outColor=associated?sampleColorAt(imageTex,pixel*(vec2(textureSize(imageTex,0))/u[6].zw)):highPrecision?sampleAt(imageTex,pixel*(vec2(textureSize(imageTex,0))/u[6].zw)):samplePixel(imageTex,q);return;}
 // Painting on the source grid must sample exact centers even for byte data:
 // normalized-coordinate filtering can leak alpha from a neighboring pixel.
 bool painting=u[7].y>=2.;
 // Document pixels use exact centers, independent of interpolated UV rounding.
 vec2 world=pixel*(u[0].xy/u[6].zw);
 vec4 b=associated?sampleColorAt(backTex,world*(vec2(textureSize(backTex,0))/u[0].xy)):(highPrecision||painting)?sampleAt(backTex,world*(vec2(textureSize(backTex,0))/u[0].xy)):samplePixel(backTex,q);
 // Backdrop coordinates belong to the target; the viewport projects sources.
 // Zero viewport extent denotes the full document.
 if(u[8].z>0.&&u[8].w>0.)world=u[8].xy+pixel*(u[8].zw/u[6].zw);
 vec2 d=world-u[1].xy-u[1].zw*.5;
 vec2 p=vec2(d.x*u[2].x+d.y*u[2].y,-d.x*u[2].y+d.y*u[2].x)/u[1].zw+.5;
 // Keep exact pixel centers in texel space; a normalized-coordinate round trip
 // can leak neighboring alpha into a pixel whose alpha is much smaller than an ULP.
 vec2 texel=vec2(0);if(highPrecision||painting||associated)texel=vec2(d.x*u[2].x+d.y*u[2].y,-d.x*u[2].y+d.y*u[2].x)*(vec2(textureSize(imageTex,0))/u[1].zw)+vec2(textureSize(imageTex,0))*.5;
 if(any(lessThan(p,vec2(0)))||any(greaterThan(p,vec2(1)))){outColor=b;return;}
 vec4 s=associated?sampleColorAt(imageTex,texel):(highPrecision||painting)?sampleAt(imageTex,texel):source(p);if(u[7].y==1.)s.a=s.r;
 if(u[3].w>0.){vec2 r=u[3].w/u[6].xy; s=vec4(0);for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){vec4 tap=associated?sampleColorAt(imageTex,texel+vec2(x,y)*u[3].w):highPrecision?sampleAt(imageTex,texel+vec2(x,y)*u[3].w):source(p+vec2(x,y)*r);if(u[7].y==1.)tap.a=tap.r;s+=vec4(tap.rgb*tap.a,tap.a)/9.;}s.rgb/=highPrecision?(s.a>0.?s.a:1.):max(s.a,.000001);}
 if(u[7].y==1.)s.rgb=vec3(u[0].zw,u[7].x);
 if(!highPrecision){s.rgb+=u[3].x;s.rgb=(s.rgb-.5)*(1.+u[3].y)+.5;s.rgb=mix(vec3(dot(s.rgb,vec3(.2126,.7152,.0722))),s.rgb,1.+u[3].z);s.rgb=clamp(s.rgb,0.,1.);}
 else{if(u[3].x!=0.)s.rgb+=u[3].x;if(u[3].y!=0.)s.rgb=(s.rgb-.5)*(1.+u[3].y)+.5;if(u[3].z!=0.)s.rgb=mix(vec3(dot(s.rgb,vec3(.2126,.7152,.0722))),s.rgb,1.+u[3].z);}
 if(highPrecision&&u[5].w>.5)s.rgb=clamp(s.rgb,0.,1.);
 s.a*=u[2].z;
 if(u[5].x>0.5 && (world.x<u[4].x||world.y<u[4].y||world.x>u[4].x+u[4].z||world.y>u[4].y+u[4].w))s.a=0.;
 // Replace (knockout): mix the backdrop toward the source by the mask.
 if(u[7].y==4.){float m=highPrecision?sampleAt(maskTex,texel*(vec2(textureSize(maskTex,0))/vec2(textureSize(imageTex,0)))).a:samplePixel(maskTex,p).a;float ka=s.a*m;float ra=ka+b.a*(1.-m);outColor=vec4(ra>0.?(s.rgb*ka+b.rgb*b.a*(1.-m))/ra:vec3(0),ra);return;}
 if(u[11].y>.5){float value=pixelMaskAt(world);if(u[5].y>.5){vec4 basis=sampleAt(maskTex,world-u[4].xy);value=value*basis.r+basis.g;}value=clamp(value,0.,1.);if(u[10].w>.5)value=1.-value;float density=u[11].x;if(density!=1.)value=(1.-density)+density*value;s.a=s.a==1.?value:s.a*value;}
 else if(u[5].y>0.5)s.a*=highPrecision?sampleAt(maskTex,texel*(vec2(textureSize(maskTex,0))/vec2(textureSize(imageTex,0)))).a:samplePixel(maskTex,p).a;
 if(u[20].x>.5)s.a*=blendIf(s.rgb,b.rgb);
 int mode=int(u[2].w);if(mode==1){s.a=dissolveNoise(world)<s.a?1.:0.;mode=0;}
 vec3 c=blendMode(mode,b.rgb,s.rgb);
 // Painting modes preserve stored alpha (2) or source-over it (3). An
 // untouched source texel retains its straight RGB even when alpha is zero.
 if(u[7].y>=2.&&s.a==0.){outColor=b;return;}
 // Excluded channels (u[20].yzw) keep the underlying values.
 vec3 keep=step(.5,u[20].yzw);
 if(u[7].y==2.){outColor=(floatBitsToUint(b.a)&0x7fffffffu)==0u?b:vec4(mix(mix(b.rgb,c,s.a),b.rgb,keep),b.a);return;}
 float a=s.a+b.a*(1.-s.a);vec3 rgb;
 // Normalize coverage before applying it to RGB: premultiplying a tiny color
 // by tiny alpha can underflow even though its straight output is representable.
 // Factor the foreground blend first; normal source-over needs no cross term.
 if(highPrecision){float total=a>0.?a:1.;vec3 front=mode==0?s.rgb:s.rgb*(1.-b.a)+c*b.a;rgb=(s.a/total)*front+((b.a/total)*(1.-s.a))*b.rgb;}
 else rgb=(s.a*(1.-b.a)*s.rgb+s.a*b.a*c+(1.-s.a)*b.a*b.rgb)/max(a,.000001);
 if(keep!=vec3(0))rgb=mix(rgb,a>0.?b.rgb*(b.a/a):vec3(0),keep);
 if(highPrecision&&u[5].w>.5)rgb=clamp(rgb,0.,1.);outColor=vec4(rgb,a);
}`;
}
export const glFragment = glShader(false, false);
export const glFloatFragment = glShader(true, false);
export const glResampleFragment = glShader(false, true);
export const glFloatResampleFragment = glShader(true, true);
function gpuShader(highPrecision: boolean, associated: boolean) {
  return `
const highPrecision:bool = ${highPrecision};
const associated:bool = ${associated};
struct U{v:array<vec4f,24>};@group(0) @binding(0)var backTex:texture_2d<f32>;@group(0) @binding(1)var imageTex:texture_2d<f32>;@group(0) @binding(2)var maskTex:texture_2d<f32>;@group(0) @binding(3)var smp:sampler;@group(0) @binding(4)var<uniform> u:U;@group(0) @binding(5)var pixelMaskTex:texture_2d<f32>;
struct V{@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:V;o.position=vec4f(p*2.-1.,0,1);o.uv=vec2f(p.x,1.-p.y);return o;}
fn sampleTexel(tex:texture_2d<f32>,pixel:vec2f,color:bool)->vec4f{
 let size=textureDimensions(tex);let at=clamp(pixel,vec2f(0),vec2f(size))-.5;
 let base=vec2i(floor(at));let f=fract(at);let hi=vec2i(size)-1;
 let a=textureLoad(tex,clamp(base,vec2i(0),hi),0);
 if(all(f==vec2f(0))){return a;}
 let b=textureLoad(tex,clamp(base+vec2i(1,0),vec2i(0),hi),0);
 let c=textureLoad(tex,clamp(base+vec2i(0,1),vec2i(0),hi),0);
 let d=textureLoad(tex,clamp(base+vec2i(1),vec2i(0),hi),0);
 if(associated && color && !(a.a==b.a && a.a==c.a && a.a==d.a)){
  let alpha=vec4f(a.a,b.a,c.a,d.a);
  var weight=vec4f((1.-f.x)*(1.-f.y),f.x*(1.-f.y),(1.-f.x)*f.y,f.x*f.y);
  let coverage=dot(alpha,weight);
  let scale=max(max(a.a,b.a),max(c.a,d.a));
  weight*=alpha/scale;let total=dot(weight,vec4f(1));
  if(total>0.){weight/=total;return vec4f(a.rgb*weight.x+b.rgb*weight.y+c.rgb*weight.z+d.rgb*weight.w,coverage);}
 }
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
fn sampleAt(tex:texture_2d<f32>,pixel:vec2f)->vec4f{return sampleTexel(tex,pixel,false);}
fn sampleColorAt(tex:texture_2d<f32>,pixel:vec2f)->vec4f{return sampleTexel(tex,pixel,true);}
fn samplePixel(tex:texture_2d<f32>,p:vec2f)->vec4f{if(!highPrecision){return textureSampleLevel(tex,smp,p,0);}return sampleAt(tex,p*vec2f(textureDimensions(tex)));}
fn alphaDivisor(a:f32)->f32{if(highPrecision){return select(1.,a,a>0.);}return max(a,.000001);}
fn source(p:vec2f)->vec4f{return samplePixel(imageTex,clamp(p,vec2f(0),vec2f(1)));}
fn maskTap(p:vec2i)->f32{let size=vec2i(textureDimensions(pixelMaskTex));if(any(p<vec2i(0))||any(p>=size)){return u.v[10].z;}return textureLoad(pixelMaskTex,p,0).r;}
fn pixelMaskAt(world:vec2f)->f32{
 if(u.v[11].z<.5){return u.v[10].z;}
 let at=vec2f(dot(world,u.v[9].xz),dot(world,u.v[9].yw))+u.v[10].xy-.5;
 let p=vec2i(floor(at));let f=fract(at);let a=maskTap(p);
 if(all(f==vec2f(0))){return a;}
 return mix(mix(a,maskTap(p+vec2i(1,0)),f.x),mix(maskTap(p+vec2i(0,1)),maskTap(p+vec2i(1)),f.x),f.y);
}
fn blendLum(c:vec3f)->f32{return dot(c,vec3f(.3,.59,.11));}
fn clipColor(c0:vec3f)->vec3f{var c=c0;let l=blendLum(c);let n=min(min(c.r,c.g),c.b);let x=max(max(c.r,c.g),c.b);if(n<0.){c=l+(c-l)*l/max(l-n,1e-6);}if(x>1.){c=l+(c-l)*(1.-l)/max(x-l,1e-6);}return c;}
fn setLum(c:vec3f,l:f32)->vec3f{return clipColor(c+(l-blendLum(c)));}
fn blendSat(c:vec3f)->f32{return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b);}
fn setSat(c:vec3f,s:f32)->vec3f{let mx=max(max(c.r,c.g),c.b);let mn=min(min(c.r,c.g),c.b);if(mx>mn){return (c-mn)*s/(mx-mn);}return vec3f(0);}
fn burn(b:f32,s:f32)->f32{if(b>=1.){return 1.;}if(s<=0.){return 0.;}return 1.-min(1.,(1.-b)/s);}
fn dodge(b:f32,s:f32)->f32{if(b<=0.){return 0.;}if(s>=1.){return 1.;}return min(1.,b/(1.-s));}
fn sepBlend(m:i32,b:f32,s:f32)->f32{
 if(m==2){return min(b,s);}if(m==3){return b*s;}if(m==4){return burn(b,s);}if(m==5){return max(b+s-1.,0.);}
 if(m==7){return max(b,s);}if(m==8){return b+s-b*s;}if(m==9){return dodge(b,s);}if(m==10){return min(b+s,1.);}
 if(m==12){return select(1.-2.*(1.-b)*(1.-s),2.*b*s,b<=.5);}
 if(m==13){if(s<=.5){return b-(1.-2.*s)*b*(1.-b);}let d=select(sqrt(b),((16.*b-12.)*b+4.)*b,b<=.25);return b+(2.*s-1.)*(d-b);}
 if(m==14){return select(1.-2.*(1.-b)*(1.-s),2.*b*s,s<=.5);}
 if(m==15){if(s<=.5){return burn(b,2.*s);}return dodge(b,2.*s-1.);}
 if(m==16){return clamp(b+2.*s-1.,0.,1.);}
 if(m==17){if(s<=.5){return min(b,2.*s);}return max(b,2.*s-1.);}
 if(m==18){return select(0.,1.,b+s>=1.);}
 if(m==19){return abs(b-s);}if(m==20){return b+s-2.*b*s;}if(m==21){return max(b-s,0.);}
 if(m==22){if(s<=0.){return select(1.,0.,b<=0.);}return min(b/s,1.);}
 return s;
}
fn blendMode(m:i32,b:vec3f,s:vec3f)->vec3f{
 if(m<=1){return s;}
 if(m==6){return select(s,b,blendLum(b)<blendLum(s));}if(m==11){return select(s,b,blendLum(b)>blendLum(s));}
 if(m==23){return setLum(setSat(s,blendSat(b)),blendLum(b));}if(m==24){return setLum(setSat(b,blendSat(s)),blendLum(b));}
 if(m==25){return setLum(s,blendLum(b));}if(m==26){return setLum(b,blendLum(s));}
 return vec3f(sepBlend(m,b.r,s.r),sepBlend(m,b.g,s.g),sepBlend(m,b.b,s.b));
}
fn dissolveNoise(p:vec2f)->f32{return fract(sin(dot(floor(p),vec2f(12.9898,78.233)))*43758.5453);}
fn rangeWeight(v:f32,r:vec4f)->f32{var lo=select(0.,1.,v>=r.x);if(r.y>r.x){lo=clamp((v-r.x)/(r.y-r.x),0.,1.);}var hi=select(0.,1.,v<=r.w);if(r.w>r.z){hi=clamp((r.w-v)/(r.w-r.z),0.,1.);}return lo*hi;}
fn toLevel(c:f32)->f32{return floor(clamp(c,0.,1.)*255.+.5);}
fn blendIf(s:vec3f,b:vec3f)->f32{
 var w=rangeWeight(toLevel(blendLum(s)),u.v[12])*rangeWeight(toLevel(blendLum(b)),u.v[13]);
 w*=rangeWeight(toLevel(s.r),u.v[14])*rangeWeight(toLevel(b.r),u.v[15]);
 w*=rangeWeight(toLevel(s.g),u.v[16])*rangeWeight(toLevel(b.g),u.v[17]);
 return w*rangeWeight(toLevel(s.b),u.v[18])*rangeWeight(toLevel(b.b),u.v[19]);
}
@fragment fn fs(v:V)->@location(0) vec4f{
 let q=v.uv;
 if(u.v[7].w>.5){var out=samplePixel(imageTex,q);if(associated){out=sampleColorAt(imageTex,v.position.xy*(vec2f(textureDimensions(imageTex))/u.v[6].zw));}else if(highPrecision){out=sampleAt(imageTex,v.position.xy*(vec2f(textureDimensions(imageTex))/u.v[6].zw));}if(u.v[7].z>.5){return out;}if(highPrecision){out=vec4f(clamp(out.rgb,vec3f(0),vec3f(1)),out.a);}return vec4f(out.rgb*out.a,out.a);}
 let painting=u.v[7].y>=2.;
 var world=v.position.xy*(u.v[0].xy/u.v[6].zw);var b=samplePixel(backTex,q);
 if(associated){b=sampleColorAt(backTex,world*(vec2f(textureDimensions(backTex))/u.v[0].xy));}else if(highPrecision||painting){world=v.position.xy*(u.v[0].xy/u.v[6].zw);b=sampleAt(backTex,world*(vec2f(textureDimensions(backTex))/u.v[0].xy));}
 if(u.v[8].z>0.&&u.v[8].w>0.){world=u.v[8].xy+v.position.xy*(u.v[8].zw/u.v[6].zw);}
 let d=world-u.v[1].xy-u.v[1].zw*.5;
 let p=vec2f(d.x*u.v[2].x+d.y*u.v[2].y,-d.x*u.v[2].y+d.y*u.v[2].x)/u.v[1].zw+.5;
 var texel=vec2f(0);if(highPrecision||painting||associated){texel=vec2f(d.x*u.v[2].x+d.y*u.v[2].y,-d.x*u.v[2].y+d.y*u.v[2].x)*(vec2f(textureDimensions(imageTex))/u.v[1].zw)+vec2f(textureDimensions(imageTex))*.5;}
 if(any(p<vec2f(0))||any(p>vec2f(1))){return b;}
 var s=source(p);if(associated){s=sampleColorAt(imageTex,texel);}else if(highPrecision||painting){s=sampleAt(imageTex,texel);}if(u.v[7].y==1.){s=vec4f(s.rgb,s.r);}if(u.v[3].w>0.){let r=u.v[3].w/u.v[6].xy;s=vec4f(0);for(var x:i32=-1;x<=1;x++){for(var y:i32=-1;y<=1;y++){var tap=source(p+vec2f(f32(x),f32(y))*r);if(associated){tap=sampleColorAt(imageTex,texel+vec2f(f32(x),f32(y))*u.v[3].w);}else if(highPrecision){tap=sampleAt(imageTex,texel+vec2f(f32(x),f32(y))*u.v[3].w);}if(u.v[7].y==1.){tap=vec4f(tap.rgb,tap.r);}s+=vec4f(tap.rgb*tap.a,tap.a)/9.;}}s=vec4f(s.rgb/alphaDivisor(s.a),s.a);}
 if(u.v[7].y==1.){s=vec4f(u.v[0].zw,u.v[7].x,s.a);}
 var rgb=s.rgb;
 if(!highPrecision){rgb+=vec3f(u.v[3].x);rgb=(rgb-.5)*(1.+u.v[3].y)+.5;rgb=mix(vec3f(dot(rgb,vec3f(.2126,.7152,.0722))),rgb,1.+u.v[3].z);rgb=clamp(rgb,vec3f(0),vec3f(1));}
 else{if(u.v[3].x!=0.){rgb+=vec3f(u.v[3].x);}if(u.v[3].y!=0.){rgb=(rgb-.5)*(1.+u.v[3].y)+.5;}if(u.v[3].z!=0.){rgb=mix(vec3f(dot(rgb,vec3f(.2126,.7152,.0722))),rgb,1.+u.v[3].z);}}
 if(highPrecision&&u.v[5].w>.5){rgb=clamp(rgb,vec3f(0),vec3f(1));}
 s=vec4f(rgb,s.a*u.v[2].z);
 if(u.v[5].x>.5&&(world.x<u.v[4].x||world.y<u.v[4].y||world.x>u.v[4].x+u.v[4].z||world.y>u.v[4].y+u.v[4].w)){s.a=0.;}
 if(u.v[7].y==4.){var m=samplePixel(maskTex,p).a;if(highPrecision){m=sampleAt(maskTex,texel*(vec2f(textureDimensions(maskTex))/vec2f(textureDimensions(imageTex)))).a;}let ka=s.a*m;let ra=ka+b.a*(1.-m);if(ra<=0.){return vec4f(0);}return vec4f((s.rgb*ka+b.rgb*b.a*(1.-m))/ra,ra);}
 if(u.v[11].y>.5){var value=pixelMaskAt(world);if(u.v[5].y>.5){let basis=sampleAt(maskTex,world-u.v[4].xy);value=value*basis.r+basis.g;}value=clamp(value,0.,1.);if(u.v[10].w>.5){value=1.-value;}let density=u.v[11].x;if(density!=1.){value=(1.-density)+density*value;}s=vec4f(s.rgb,select(s.a*value,value,s.a==1.));}
 else if(u.v[5].y>.5){if(highPrecision){s.a*=sampleAt(maskTex,texel*(vec2f(textureDimensions(maskTex))/vec2f(textureDimensions(imageTex)))).a;}else{s.a*=samplePixel(maskTex,p).a;}}
 if(u.v[20].x>.5){s.a*=blendIf(s.rgb,b.rgb);}
 var mode=i32(u.v[2].w);if(mode==1){s.a=select(0.,1.,dissolveNoise(world)<s.a);mode=0;}
 let c=blendMode(mode,b.rgb,s.rgb);
 if(u.v[7].y>=2.&&s.a==0.){return b;}
 let keep=step(vec3f(.5),u.v[20].yzw);
 if(u.v[7].y==2.){if((bitcast<u32>(b.a)&0x7fffffffu)==0u){return b;}return vec4f(mix(mix(b.rgb,c,s.a),b.rgb,keep),b.a);}
 let a=s.a+b.a*(1.-s.a);var result:vec3f;
 if(highPrecision){let total=alphaDivisor(a);var front=s.rgb;if(mode!=0){front=s.rgb*(1.-b.a)+c*b.a;}result=(s.a/total)*front+((b.a/total)*(1.-s.a))*b.rgb;}
 else{result=(s.a*(1.-b.a)*s.rgb+s.a*b.a*c+(1.-s.a)*b.a*b.rgb)/alphaDivisor(a);}
 if(any(keep!=vec3f(0))){var under=vec3f(0);if(a>0.){under=b.rgb*(b.a/a);}result=mix(result,under,keep);}
 if(highPrecision&&u.v[5].w>.5){result=clamp(result,vec3f(0),vec3f(1));}return vec4f(result,a);
}`;
}
export const wgsl = gpuShader(false, false);
export const wgslFloat = gpuShader(true, false);
export const wgslResample = gpuShader(false, true);
export const wgslFloatResample = gpuShader(true, true);
