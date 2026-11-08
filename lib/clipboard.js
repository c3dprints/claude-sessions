// Reads an image from this computer's clipboard, for screenshots the browser cannot
// hand over (some screenshot tools' formats, image files copied in Explorer).
const { execFile } = require('child_process');

const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

function run(cmd, args, env) {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { ...process.env, ...env }, timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Saves a clipboard picture to `out` as PNG: { image: true }. Image files copied in
// Explorer or Finder come back as paths instead: { files: [...] }. Nothing usable: {}.
async function readImage(out) {
  if (process.platform === 'win32') {
    // The clipboard needs a single-threaded apartment; the path comes in through env.
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing',
      '$c = [System.Windows.Forms.Clipboard]',
      'if ($c::ContainsImage()) { $c::GetImage().Save($env:CS_CLIP_OUT, [System.Drawing.Imaging.ImageFormat]::Png); "IMAGE" } ' +
        'elseif ($c::ContainsFileDropList()) { $c::GetFileDropList() | ForEach-Object { "FILE $_" } }',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps], { CS_CLIP_OUT: out });
    return parse(r);
  }
  if (process.platform === 'darwin') {
    const r = await run('osascript', [
      '-e', 'try',
      '-e', 'set f to open for access POSIX file (system attribute "CS_CLIP_OUT") with write permission',
      '-e', 'write (the clipboard as «class PNGf») to f',
      '-e', 'close access f',
      '-e', 'return "IMAGE"',
      '-e', 'end try',
    ], { CS_CLIP_OUT: out });
    return parse(r);
  }
  return {};
}

function parse(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.includes('IMAGE')) return { image: true };
  const files = lines.filter((l) => l.startsWith('FILE ')).map((l) => l.slice(5)).filter((f) => IMAGE_FILE.test(f));
  return files.length ? { files } : {};
}

module.exports = { readImage, parse };
