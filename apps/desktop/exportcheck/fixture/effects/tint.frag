// A project-local effect, deliberately unmistakable.
//
// The delivered file used to be rendered with the builtins alone, so an effect living in the project's
// own `effects/` folder appeared in the preview and silently vanished from the export. Turning every
// lit pixel hard red is a change no antialiasing or codec can be blamed for.
void main() {
  vec4 colour = texture(source, v_uv);
  fragColor = vec4(colour.a > 0.0 ? vec3(1.0, 0.0, 0.0) : colour.rgb, colour.a);
}
