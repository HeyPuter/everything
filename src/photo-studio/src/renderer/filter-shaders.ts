// Image filter passes for spatial adjustment layers (Clarity & Dehaze,
// Grain). The math mirrors src/imaging/adjust/spatial.ts; keep the GLSL and
// WGSL versions, and the CPU reference, in step.
//
// Every pass reads up to three textures with texelFetch/textureLoad (so byte
// and float sources both work) and writes one target. Uniforms u[0..3]:
// u[0].x selects the mode.
//   1 reduce: u[0].y = factor. Block averages of (luma * alpha, alpha), the
//     block's dark channel (min of R, G, B over pixels with alpha, else 1) and
//     its largest alpha.
//   2 separable: u[0].yz = step direction. u[1] = (sigma, radius) of the
//     Gaussian on .rg (radius 0 copies), then the .b operation (0 copy, 1 min,
//     2 Gaussian), its radius; u[2].x = .b sigma. Edges repeat the border.
//   3 max: u[0].y = factor. Largest .b over block pixels with alpha > 0;
//     alpha 1 when any pixel had alpha.
//   4 clarity/dehaze: sources image, reduced planes, 1x1 light. u[0].y =
//     factor, u[1] = (clarity, dehaze, clarity on, dehaze on), u[2].x = clamp.
//   5 grain: u[1] = (strength, cell, roughness, color), u[2].x = clamp,
//     u[2].yz = document position of texel (0, 0).
// Relight layers (src/imaging/relight/surface.ts is the CPU reference):
//   6 height: sources three blurred (L*a, a) planes; u[1].xyz = weights.
//     Writes (height, fine luminance guide, fine alpha, 1).
//   7 cross-bilateral: u[0].yz = direction, u[1] = (sigma, radius, range
//     sigma) smoothing .r guided by .g.
//   8 normals: u[1] = (slope, relief). Writes (normal, height in pixels).
//   9 shade: sources image, normal plane, shadow plane. u[0] = (9, factor,
//     lights, clamp), u[1].x = ambient, u[2].xy = document position of texel
//     (0, 0), u[3].x = shadows on; light k at u[4 + 2k] = (x, y, z, reach)
//     and u[5 + 2k] = (linear color times intensity, wrap).
//   10 shadows: source the normal plane. u[0] = (10, factor, lights),
//     u[1].yzw = (strength, steps, step length); lights as in 9. Two
//     factors per channel at 8-bit precision (packPair).
// Floats in the filter pass uniform array (vec4 u[24]).
export const FILTER_UNIFORM_FLOATS = 96;

export const glFilterFragment = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D src0;uniform highp sampler2D src1;uniform highp sampler2D src2;uniform vec4 u[24];
out vec4 outColor;
const vec3 LUMA=vec3(.2126,.7152,.0722);
vec4 tap(ivec2 p,ivec2 dir,int i){ivec2 s=textureSize(src0,0);return texelFetch(src0,clamp(p+dir*i,ivec2(0),s-1),0);}
uint mixHash(uint h0){uint h=h0;h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return h;}
float hash(int x,int y,uint seed){uint h=(uint(x)*0x8da6b343u)^(uint(y)*0xd8163841u)^(seed*0xcb1ab31fu);return float(mixHash(h)>>8u)/16777216.*2.-1.;}
float noise(vec2 q,uint seed){vec2 i=floor(q);vec2 f=q-i;vec2 w=f*f*(3.-2.*f);int x=int(i.x),y=int(i.y);
 float top=mix(hash(x,y,seed),hash(x+1,y,seed),w.x);float bottom=mix(hash(x,y+1,seed),hash(x+1,y+1,seed),w.x);return mix(top,bottom,w.y);}
float pack2(float a,float b){return floor(clamp(a,0.,1.)*255.+.5)*256.+floor(clamp(b,0.,1.)*255.+.5);}
vec2 unpack2(float v){float hi=floor(v/256.);return vec2(hi,v-hi*256.)/255.;}
float shadowOf(ivec2 q,int k){
 ivec2 s=textureSize(src0,0);float f=u[0].y;float H=texelFetch(src0,q,0).w;vec2 P=(vec2(q)+.5)*f;vec4 A=u[4+2*k];vec4 B=u[5+2*k];
 vec2 d=A.xy-P;float dist=length(d);if(dist<f)return 1.;vec2 un=d/dist;float rise=(A.z-H)/dist;float soft=.05+.5*B.w;float t=0.,occl=0.;int steps=int(u[1].z);
 for(int i=0;i<64;i++){if(i>=steps)break;t+=u[1].w*(1.+.25*float(i));float travel=t*f;if(travel>=dist)break;
  ivec2 sp=ivec2(floor(vec2(q)+.5+un*t));if(sp.x<0||sp.y<0||sp.x>=s.x||sp.y>=s.y)break;
  float above=texelFetch(src0,sp,0).w-(H+rise*travel);if(above<=0.)continue;float o=min(1.,above/(soft*travel+1e-3));occl=max(occl,o*o*(3.-2.*o));}
 return 1.-occl*u[1].y;}
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);int mode=int(u[0].x);
 if(mode==1){
  int f=int(u[0].y);ivec2 s=textureSize(src0,0);ivec2 o=p*f;ivec2 e=min(o+f,s);
  float la=0.,a=0.,d=1.,m=0.,n=0.;
  for(int y=o.y;y<e.y;y++)for(int x=o.x;x<e.x;x++){vec4 c=texelFetch(src0,ivec2(x,y),0);la+=dot(c.rgb,LUMA)*c.a;a+=c.a;n+=1.;if(c.a>0.){d=min(d,min(c.r,min(c.g,c.b)));m=max(m,c.a);}}
  outColor=vec4(la/n,a/n,d,m);return;
 }
 if(mode==2){
  ivec2 dir=ivec2(u[0].yz);vec4 c=texelFetch(src0,p,0);vec4 o=c;
  int rc=int(u[1].y);
  if(rc>0){float sg=u[1].x,sr=0.,sa=0.,sw=0.;for(int i=-rc;i<=rc;i++){float w=exp(-float(i*i)/(2.*sg*sg));vec4 t=tap(p,dir,i);sr+=w*t.r;sa+=w*t.g;sw+=w;}o.r=sr/sw;o.g=sa/sw;}
  int op=int(u[1].z),rb=int(u[1].w);
  if(op==1){float m=c.b;for(int i=-rb;i<=rb;i++)m=min(m,tap(p,dir,i).b);o.b=m;}
  else if(op==2){float sg=u[2].x,sb=0.,sw=0.;for(int i=-rb;i<=rb;i++){float w=exp(-float(i*i)/(2.*sg*sg));sb+=w*tap(p,dir,i).b;sw+=w;}o.b=sb/sw;}
  outColor=o;return;
 }
 if(mode==3){
  int f=int(u[0].y);ivec2 s=textureSize(src0,0);ivec2 o=p*f;ivec2 e=min(o+f,s);float m=0.,any=0.;
  for(int y=o.y;y<e.y;y++)for(int x=o.x;x<e.x;x++){vec4 c=texelFetch(src0,ivec2(x,y),0);if(c.a>0.){m=max(m,c.b);any=1.;}}
  outColor=vec4(m,m,m,any);return;
 }
 if(mode==4){
  vec4 c=texelFetch(src0,p,0);if(c.a<=0.){outColor=c;return;}
  float f=u[0].y;ivec2 ls=textureSize(src1,0);vec2 q=(vec2(p)+.5)/f-.5;vec2 i0=floor(q);vec2 t=q-i0;
  ivec2 a0=clamp(ivec2(i0),ivec2(0),ls-1);ivec2 a1=clamp(ivec2(i0)+1,ivec2(0),ls-1);
  vec4 sl=mix(mix(texelFetch(src1,a0,0),texelFetch(src1,ivec2(a1.x,a0.y),0),t.x),mix(texelFetch(src1,ivec2(a0.x,a1.y),0),texelFetch(src1,a1,0),t.x),t.y);
  float L=clamp(dot(c.rgb,LUMA),0.,1.);vec3 o=c.rgb;float k=u[1].y;
  if(u[1].w>.5){vec4 l1=texelFetch(src2,ivec2(0),0);float A=l1.a>0.?max(l1.b,.05):1.;
   if(k>0.){float tr=max(1.-.95*k*sl.b/A,.1);o=(c.rgb-A)/tr+A;}
   else if(k<0.){float fog=max(A,.75);o=c.rgb+(fog-c.rgb)*(-k*.6);}}
  if(u[1].z>.5&&sl.g>1e-6){float cl=u[1].x;float amt=cl>0.?1.5*cl:cl;o+=amt*(L-sl.r/sl.g)*4.*L*(1.-L);}
  o=max(o,vec3(0));if(u[2].x>.5)o=min(o,vec3(1));outColor=vec4(o,c.a);return;
 }
 if(mode==5){
  vec4 c=texelFetch(src0,p,0);if(c.a<=0.){outColor=c;return;}
  float k=u[1].x,s=u[1].y,r=u[1].z,col=u[1].w;vec2 q=vec2(p)+u[2].yz+.5;
  float n=noise(q/s,1u)*(1.-r)+noise(q/(s*.5),2u)*r;
  float L=clamp(dot(c.rgb,LUMA),0.,1.);float wt=.35+2.6*L*(1.-L);
  vec3 o=c.rgb+k*n*wt;
  if(col>0.)o+=k*col*wt*vec3(noise(q/s,3u),noise(q/s,4u),noise(q/s,5u));
  o=max(o,vec3(0));if(u[2].x>.5)o=min(o,vec3(1));outColor=vec4(o,c.a);return;
 }
 if(mode==6){vec4 b1=texelFetch(src0,p,0),b2=texelFetch(src1,p,0),b3=texelFetch(src2,p,0);
  float l1=b1.g>1e-6?b1.r/b1.g:0.,l2=b2.g>1e-6?b2.r/b2.g:0.,l3=b3.g>1e-6?b3.r/b3.g:0.;
  outColor=vec4(u[1].x*l1+u[1].y*l2+u[1].z*l3,l1,b1.g,1);return;}
 if(mode==7){ivec2 dir=ivec2(u[0].yz);vec4 c=texelFetch(src0,p,0);int r=int(u[1].y);float s2=2.*u[1].x*u[1].x,r2=2.*u[1].z*u[1].z,acc=0.,sw=0.;
  for(int i=-r;i<=r;i++){vec4 t=tap(p,dir,i);float d=t.g-c.g;float w=exp(-float(i*i)/s2)*exp(-d*d/r2);acc+=w*t.r;sw+=w;}
  outColor=vec4(acc/sw,c.gba);return;}
 if(mode==8){float hr=tap(p,ivec2(1,0),1).r,hl=tap(p,ivec2(1,0),-1).r,hd=tap(p,ivec2(0,1),1).r,hu=tap(p,ivec2(0,1),-1).r;
  vec3 n=normalize(vec3(-(hr-hl)*.5*u[1].x,-(hd-hu)*.5*u[1].x,1.));outColor=vec4(n,texelFetch(src0,p,0).r*u[1].y);return;}
 if(mode==10){int count=int(u[0].z);vec4 o=vec4(0);
  for(int ch=0;ch<4;ch++){float a=2*ch<count?shadowOf(p,2*ch):1.;float b=2*ch+1<count?shadowOf(p,2*ch+1):1.;o[ch]=pack2(a,b);}
  outColor=o;return;}
 if(mode==9){
  vec4 c=texelFetch(src0,p,0);if(c.a<=0.){outColor=c;return;}
  float f=u[0].y;ivec2 ls=textureSize(src1,0);vec2 q=(vec2(p)+.5)/f-.5;vec2 i0=floor(q);vec2 t=q-i0;
  ivec2 a0=clamp(ivec2(i0),ivec2(0),ls-1);ivec2 a1=clamp(ivec2(i0)+1,ivec2(0),ls-1);ivec2 b0=ivec2(a1.x,a0.y);ivec2 b1=ivec2(a0.x,a1.y);
  vec4 nn=mix(mix(texelFetch(src1,a0,0),texelFetch(src1,b0,0),t.x),mix(texelFetch(src1,b1,0),texelFetch(src1,a1,0),t.x),t.y);
  vec3 n=length(nn.xyz)>1e-6?normalize(nn.xyz):vec3(0,0,1);float H=nn.w;
  float sh[8];for(int k=0;k<8;k++)sh[k]=1.;
  if(u[3].x>.5){vec4 s00=texelFetch(src2,a0,0),s10=texelFetch(src2,b0,0),s01=texelFetch(src2,b1,0),s11=texelFetch(src2,a1,0);
   for(int ch=0;ch<4;ch++){vec2 v=mix(mix(unpack2(s00[ch]),unpack2(s10[ch]),t.x),mix(unpack2(s01[ch]),unpack2(s11[ch]),t.x),t.y);sh[2*ch]=v.x;sh[2*ch+1]=v.y;}}
  vec2 P=vec2(p)+u[2].xy+.5;vec3 sum=vec3(0);int count=int(u[0].z);
  for(int k=0;k<8;k++){if(k>=count)break;vec4 A=u[4+2*k];vec4 B=u[5+2*k];vec3 L=vec3(A.xy-P,A.z-H);float dist=max(1e-3,length(L));
   float d=max(0.,(dot(n,L)/dist+B.w)/(1.+B.w));float qq=dist/A.w;sum+=B.rgb*(d/(1.+qq*qq))*sh[k];}
  vec3 lin=pow(max(c.rgb,vec3(0)),vec3(2.2));vec3 o=pow(max(lin*(u[1].x+sum),vec3(0)),vec3(1./2.2));if(u[0].w>.5)o=min(o,vec3(1));outColor=vec4(o,c.a);return;
 }
 outColor=texelFetch(src0,p,0);
}`;

export const wgslFilter = `
struct U{v:array<vec4f,24>};
@group(0) @binding(0)var src0:texture_2d<f32>;@group(0) @binding(1)var src1:texture_2d<f32>;@group(0) @binding(2)var src2:texture_2d<f32>;@group(0) @binding(3)var<uniform> u:U;
struct V{@builtin(position) position:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->V{let p=vec2f(f32((i<<1u)&2u),f32(i&2u));var o:V;o.position=vec4f(p*2.-1.,0,1);return o;}
const LUMA=vec3f(.2126,.7152,.0722);
fn tap(p:vec2i,dir:vec2i,i:i32)->vec4f{let s=vec2i(textureDimensions(src0));return textureLoad(src0,clamp(p+dir*i,vec2i(0),s-1),0);}
fn mixHash(h0:u32)->u32{var h=h0;h^=h>>16u;h*=0x7feb352du;h^=h>>15u;h*=0x846ca68bu;h^=h>>16u;return h;}
fn hash(x:i32,y:i32,seed:u32)->f32{let h=(bitcast<u32>(x)*0x8da6b343u)^(bitcast<u32>(y)*0xd8163841u)^(seed*0xcb1ab31fu);return f32(mixHash(h)>>8u)/16777216.*2.-1.;}
fn noise(q:vec2f,seed:u32)->f32{let i=floor(q);let f=q-i;let w=f*f*(3.-2.*f);let x=i32(i.x);let y=i32(i.y);
 let top=mix(hash(x,y,seed),hash(x+1,y,seed),w.x);let bottom=mix(hash(x,y+1,seed),hash(x+1,y+1,seed),w.x);return mix(top,bottom,w.y);}
fn pack2(a:f32,b:f32)->f32{return floor(clamp(a,0.,1.)*255.+.5)*256.+floor(clamp(b,0.,1.)*255.+.5);}
fn unpack2(v:f32)->vec2f{let hi=floor(v/256.);return vec2f(hi,v-hi*256.)/255.;}
fn shadowOf(q:vec2i,k:i32)->f32{
 let s=vec2i(textureDimensions(src0));let f=u.v[0].y;let H=textureLoad(src0,q,0).w;let P=(vec2f(q)+.5)*f;let A=u.v[4+2*k];let B=u.v[5+2*k];
 let d=A.xy-P;let dist=length(d);if(dist<f){return 1.;}let un=d/dist;let rise=(A.z-H)/dist;let soft=.05+.5*B.w;var t=0.;var occl=0.;let steps=i32(u.v[1].z);
 for(var i=0;i<64;i++){if(i>=steps){break;}t+=u.v[1].w*(1.+.25*f32(i));let travel=t*f;if(travel>=dist){break;}
  let sp=vec2i(floor(vec2f(q)+.5+un*t));if(sp.x<0||sp.y<0||sp.x>=s.x||sp.y>=s.y){break;}
  let above=textureLoad(src0,sp,0).w-(H+rise*travel);if(above<=0.){continue;}let o=min(1.,above/(soft*travel+1e-3));occl=max(occl,o*o*(3.-2.*o));}
 return 1.-occl*u.v[1].y;}
@fragment fn fs(v:V)->@location(0) vec4f{
 let p=vec2i(v.position.xy);let mode=i32(u.v[0].x);
 if(mode==1){
  let f=i32(u.v[0].y);let s=vec2i(textureDimensions(src0));let o=p*f;let e=min(o+f,s);
  var la=0.;var a=0.;var d=1.;var m=0.;var n=0.;
  for(var y=o.y;y<e.y;y++){for(var x=o.x;x<e.x;x++){let c=textureLoad(src0,vec2i(x,y),0);la+=dot(c.rgb,LUMA)*c.a;a+=c.a;n+=1.;if(c.a>0.){d=min(d,min(c.r,min(c.g,c.b)));m=max(m,c.a);}}}
  return vec4f(la/n,a/n,d,m);
 }
 if(mode==2){
  let dir=vec2i(u.v[0].yz);let c=textureLoad(src0,p,0);var o=c;
  let rc=i32(u.v[1].y);
  if(rc>0){let sg=u.v[1].x;var sr=0.;var sa=0.;var sw=0.;for(var i=-rc;i<=rc;i++){let w=exp(-f32(i*i)/(2.*sg*sg));let t=tap(p,dir,i);sr+=w*t.r;sa+=w*t.g;sw+=w;}o.r=sr/sw;o.g=sa/sw;}
  let op=i32(u.v[1].z);let rb=i32(u.v[1].w);
  if(op==1){var m=c.b;for(var i=-rb;i<=rb;i++){m=min(m,tap(p,dir,i).b);}o.b=m;}
  else if(op==2){let sg=u.v[2].x;var sb=0.;var sw=0.;for(var i=-rb;i<=rb;i++){let w=exp(-f32(i*i)/(2.*sg*sg));sb+=w*tap(p,dir,i).b;sw+=w;}o.b=sb/sw;}
  return o;
 }
 if(mode==3){
  let f=i32(u.v[0].y);let s=vec2i(textureDimensions(src0));let o=p*f;let e=min(o+f,s);var m=0.;var any=0.;
  for(var y=o.y;y<e.y;y++){for(var x=o.x;x<e.x;x++){let c=textureLoad(src0,vec2i(x,y),0);if(c.a>0.){m=max(m,c.b);any=1.;}}}
  return vec4f(m,m,m,any);
 }
 if(mode==4){
  let c=textureLoad(src0,p,0);if(c.a<=0.){return c;}
  let f=u.v[0].y;let ls=vec2i(textureDimensions(src1));let q=(vec2f(p)+.5)/f-.5;let i0=floor(q);let t=q-i0;
  let a0=clamp(vec2i(i0),vec2i(0),ls-1);let a1=clamp(vec2i(i0)+1,vec2i(0),ls-1);
  let sl=mix(mix(textureLoad(src1,a0,0),textureLoad(src1,vec2i(a1.x,a0.y),0),t.x),mix(textureLoad(src1,vec2i(a0.x,a1.y),0),textureLoad(src1,a1,0),t.x),t.y);
  let L=clamp(dot(c.rgb,LUMA),0.,1.);var o=c.rgb;let k=u.v[1].y;
  if(u.v[1].w>.5){let l1=textureLoad(src2,vec2i(0),0);var A=1.;if(l1.a>0.){A=max(l1.b,.05);}
   if(k>0.){let tr=max(1.-.95*k*sl.b/A,.1);o=(c.rgb-vec3f(A))/tr+vec3f(A);}
   else if(k<0.){let fog=max(A,.75);o=c.rgb+(vec3f(fog)-c.rgb)*(-k*.6);}}
  if(u.v[1].z>.5&&sl.g>1e-6){let cl=u.v[1].x;var amt=cl;if(cl>0.){amt=1.5*cl;}o+=vec3f(amt*(L-sl.r/sl.g)*4.*L*(1.-L));}
  o=max(o,vec3f(0));if(u.v[2].x>.5){o=min(o,vec3f(1));}return vec4f(o,c.a);
 }
 if(mode==5){
  let c=textureLoad(src0,p,0);if(c.a<=0.){return c;}
  let k=u.v[1].x;let s=u.v[1].y;let r=u.v[1].z;let col=u.v[1].w;let q=vec2f(p)+u.v[2].yz+.5;
  let n=noise(q/s,1u)*(1.-r)+noise(q/(s*.5),2u)*r;
  let L=clamp(dot(c.rgb,LUMA),0.,1.);let wt=.35+2.6*L*(1.-L);
  var o=c.rgb+vec3f(k*n*wt);
  if(col>0.){o+=k*col*wt*vec3f(noise(q/s,3u),noise(q/s,4u),noise(q/s,5u));}
  o=max(o,vec3f(0));if(u.v[2].x>.5){o=min(o,vec3f(1));}return vec4f(o,c.a);
 }
 if(mode==6){let b1=textureLoad(src0,p,0);let b2=textureLoad(src1,p,0);let b3=textureLoad(src2,p,0);
  let l1=select(0.,b1.r/b1.g,b1.g>1e-6);let l2=select(0.,b2.r/b2.g,b2.g>1e-6);let l3=select(0.,b3.r/b3.g,b3.g>1e-6);
  return vec4f(u.v[1].x*l1+u.v[1].y*l2+u.v[1].z*l3,l1,b1.g,1.);}
 if(mode==7){let dir=vec2i(u.v[0].yz);let c=textureLoad(src0,p,0);let r=i32(u.v[1].y);let s2=2.*u.v[1].x*u.v[1].x;let r2=2.*u.v[1].z*u.v[1].z;var acc=0.;var sw=0.;
  for(var i=-r;i<=r;i++){let t=tap(p,dir,i);let d=t.g-c.g;let w=exp(-f32(i*i)/s2)*exp(-d*d/r2);acc+=w*t.r;sw+=w;}
  return vec4f(acc/sw,c.g,c.b,c.a);}
 if(mode==8){let hr=tap(p,vec2i(1,0),1).r;let hl=tap(p,vec2i(1,0),-1).r;let hd=tap(p,vec2i(0,1),1).r;let hu=tap(p,vec2i(0,1),-1).r;
  let n=normalize(vec3f(-(hr-hl)*.5*u.v[1].x,-(hd-hu)*.5*u.v[1].x,1.));return vec4f(n,textureLoad(src0,p,0).r*u.v[1].y);}
 if(mode==10){let count=i32(u.v[0].z);var o=vec4f(0.);
  for(var ch=0;ch<4;ch++){var a=1.;var b=1.;if(2*ch<count){a=shadowOf(p,2*ch);}if(2*ch+1<count){b=shadowOf(p,2*ch+1);}o[ch]=pack2(a,b);}
  return o;}
 if(mode==9){
  let c=textureLoad(src0,p,0);if(c.a<=0.){return c;}
  let f=u.v[0].y;let ls=vec2i(textureDimensions(src1));let q=(vec2f(p)+.5)/f-.5;let i0=floor(q);let t=q-i0;
  let a0=clamp(vec2i(i0),vec2i(0),ls-1);let a1=clamp(vec2i(i0)+1,vec2i(0),ls-1);let b0=vec2i(a1.x,a0.y);let b1=vec2i(a0.x,a1.y);
  let nn=mix(mix(textureLoad(src1,a0,0),textureLoad(src1,b0,0),t.x),mix(textureLoad(src1,b1,0),textureLoad(src1,a1,0),t.x),t.y);
  var n=vec3f(0.,0.,1.);if(length(nn.xyz)>1e-6){n=normalize(nn.xyz);}let H=nn.w;
  var sh=array<f32,8>(1.,1.,1.,1.,1.,1.,1.,1.);
  if(u.v[3].x>.5){let s00=textureLoad(src2,a0,0);let s10=textureLoad(src2,b0,0);let s01=textureLoad(src2,b1,0);let s11=textureLoad(src2,a1,0);
   for(var ch=0;ch<4;ch++){let w=mix(mix(unpack2(s00[ch]),unpack2(s10[ch]),t.x),mix(unpack2(s01[ch]),unpack2(s11[ch]),t.x),t.y);sh[2*ch]=w.x;sh[2*ch+1]=w.y;}}
  let P=vec2f(p)+u.v[2].xy+.5;var sum=vec3f(0.);let count=i32(u.v[0].z);
  for(var k=0;k<8;k++){if(k>=count){break;}let A=u.v[4+2*k];let B=u.v[5+2*k];let L=vec3f(A.xy-P,A.z-H);let dist=max(1e-3,length(L));
   let d=max(0.,(dot(n,L)/dist+B.w)/(1.+B.w));let qq=dist/A.w;sum+=B.rgb*(d/(1.+qq*qq))*sh[k];}
  let lin=pow(max(c.rgb,vec3f(0.)),vec3f(2.2));var o=pow(max(lin*(u.v[1].x+sum),vec3f(0.)),vec3f(1./2.2));if(u.v[0].w>.5){o=min(o,vec3f(1.));}return vec4f(o,c.a);
 }
 return textureLoad(src0,p,0);
}`;
