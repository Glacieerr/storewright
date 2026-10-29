/** 着色器里共用的噪声函数（天空、水面、草地、云） */
export const NOISE_GLSL = /* glsl */ `
float swHash12( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
vec2 swHash22( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.xx + p3.yz ) * p3.zy );
}
float swNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = swHash12( i );
  float b = swHash12( i + vec2( 1.0, 0.0 ) );
  float c = swHash12( i + vec2( 0.0, 1.0 ) );
  float d = swHash12( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float swFbm( vec2 p ) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2( 0.8, -0.6, 0.6, 0.8 );
  for ( int i = 0; i < 5; i ++ ) {
    v += a * swNoise( p );
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
float swFbm3( vec2 p ) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2( 0.8, -0.6, 0.6, 0.8 );
  for ( int i = 0; i < 3; i ++ ) {
    v += a * swNoise( p );
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return v;
}
`;
