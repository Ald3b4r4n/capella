# Records from the default Windows input device with the waveIn API (winmm; nothing to install) into a
# 16 kHz mono 16-bit PCM WAV. (MCI was tried first: on the development machine it refused 16-bit and
# delivered 8-bit audio.)
#
# Protocol (stdout, one line each): RECORDING, then DONE <ms> | CANCELLED. A line on stdin ("stop" or
# "cancel") ends the recording; closing stdin or reaching -MaxSeconds counts as "stop".
# Errors go to stderr and the exit code is 1.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxSeconds = 120
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public class CapellaWaveRecorder {
  [StructLayout(LayoutKind.Sequential)]
  struct WAVEFORMATEX { public ushort wFormatTag, nChannels; public uint nSamplesPerSec, nAvgBytesPerSec; public ushort nBlockAlign, wBitsPerSample, cbSize; }
  [StructLayout(LayoutKind.Sequential)]
  struct WAVEHDR { public IntPtr lpData; public uint dwBufferLength, dwBytesRecorded; public IntPtr dwUser; public uint dwFlags, dwLoops; public IntPtr lpNext, reserved; }

  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, uint dev, ref WAVEFORMATEX fmt, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInStop(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  [DllImport("winmm.dll", CharSet = CharSet.Unicode)] static extern int waveInGetErrorText(int err, StringBuilder text, int len);

  const uint WAVE_MAPPER = 0xFFFFFFFF;
  const uint WHDR_DONE = 1;
  const int BUFFERS = 4;
  const int BUFFER_BYTES = 3200; // 100 ms at 16 kHz mono 16-bit

  IntPtr handle = IntPtr.Zero;
  readonly IntPtr[] headers = new IntPtr[BUFFERS];
  readonly IntPtr[] buffers = new IntPtr[BUFFERS];
  readonly MemoryStream data = new MemoryStream();
  readonly int headerSize = Marshal.SizeOf(typeof(WAVEHDR));

  static void Check(int result, string what) {
    if (result == 0) return;
    var sb = new StringBuilder(256);
    waveInGetErrorText(result, sb, 256);
    throw new Exception(what + " failed: " + sb.ToString());
  }

  public void Start() {
    var fmt = new WAVEFORMATEX { wFormatTag = 1, nChannels = 1, nSamplesPerSec = 16000, nAvgBytesPerSec = 32000, nBlockAlign = 2, wBitsPerSample = 16, cbSize = 0 };
    int r = waveInOpen(out handle, WAVE_MAPPER, ref fmt, IntPtr.Zero, IntPtr.Zero, 0);
    if (r != 0) {
      var sb = new StringBuilder(256);
      waveInGetErrorText(r, sb, 256);
      throw new Exception("Could not open the microphone: " + sb.ToString());
    }
    for (int i = 0; i < BUFFERS; i++) {
      buffers[i] = Marshal.AllocHGlobal(BUFFER_BYTES);
      var hdr = new WAVEHDR { lpData = buffers[i], dwBufferLength = BUFFER_BYTES };
      headers[i] = Marshal.AllocHGlobal(headerSize);
      Marshal.StructureToPtr(hdr, headers[i], false);
      Check(waveInPrepareHeader(handle, headers[i], headerSize), "waveInPrepareHeader");
      Check(waveInAddBuffer(handle, headers[i], headerSize), "waveInAddBuffer");
    }
    Check(waveInStart(handle), "waveInStart");
  }

  // Collects finished buffers and gives them back to the driver. Call often (every ~20 ms).
  public void Poll() {
    for (int i = 0; i < BUFFERS; i++) {
      var hdr = (WAVEHDR)Marshal.PtrToStructure(headers[i], typeof(WAVEHDR));
      if ((hdr.dwFlags & WHDR_DONE) == 0) continue;
      if (hdr.dwBytesRecorded > 0) {
        var chunk = new byte[hdr.dwBytesRecorded];
        Marshal.Copy(hdr.lpData, chunk, 0, chunk.Length);
        data.Write(chunk, 0, chunk.Length);
      }
      waveInAddBuffer(handle, headers[i], headerSize);
    }
  }

  void Release() {
    if (handle != IntPtr.Zero) {
      waveInStop(handle);
      waveInReset(handle);
      for (int i = 0; i < BUFFERS; i++) if (headers[i] != IntPtr.Zero) waveInUnprepareHeader(handle, headers[i], headerSize);
      waveInClose(handle);
      handle = IntPtr.Zero;
    }
    for (int i = 0; i < BUFFERS; i++) {
      if (headers[i] != IntPtr.Zero) { Marshal.FreeHGlobal(headers[i]); headers[i] = IntPtr.Zero; }
      if (buffers[i] != IntPtr.Zero) { Marshal.FreeHGlobal(buffers[i]); buffers[i] = IntPtr.Zero; }
    }
  }

  // Stops, collects what is left, writes the WAV and returns its length in milliseconds.
  public int Stop(string path) {
    if (handle != IntPtr.Zero) { waveInStop(handle); waveInReset(handle); Poll(); }
    Release();
    byte[] pcm = data.ToArray();
    using (var f = new FileStream(path, FileMode.Create, FileAccess.Write)) {
      var w = new BinaryWriter(f);
      w.Write(Encoding.ASCII.GetBytes("RIFF")); w.Write(36 + pcm.Length);
      w.Write(Encoding.ASCII.GetBytes("WAVE")); w.Write(Encoding.ASCII.GetBytes("fmt "));
      w.Write(16); w.Write((short)1); w.Write((short)1); w.Write(16000); w.Write(32000); w.Write((short)2); w.Write((short)16);
      w.Write(Encoding.ASCII.GetBytes("data")); w.Write(pcm.Length); w.Write(pcm);
      w.Flush();
    }
    return pcm.Length / 32;
  }

  public void Abort() { Release(); }

  // Console.In.ReadLineAsync completes synchronously (it blocks until a line arrives), so stdin is read on a
  // background thread. Command stays null until a line or end-of-input arrives.
  public volatile string Command;
  public void WatchStdin() {
    var t = new System.Threading.Thread(() => {
      string line = null;
      try { line = Console.In.ReadLine(); } catch { }
      Command = line == null ? "stop" : line.Trim();
    });
    t.IsBackground = true;
    t.Start();
  }
}
'@

$rec = New-Object CapellaWaveRecorder
try {
  $rec.Start()
  [Console]::Out.WriteLine('RECORDING')
  [Console]::Out.Flush()

  $deadline = [DateTime]::UtcNow.AddSeconds($MaxSeconds)
  $rec.WatchStdin()
  while ($null -eq $rec.Command -and [DateTime]::UtcNow -lt $deadline) {
    $rec.Poll()
    Start-Sleep -Milliseconds 20
  }
  $cmd = if ($null -ne $rec.Command) { $rec.Command } else { 'stop' }

  if ($cmd -eq 'cancel') {
    $rec.Abort()
    [Console]::Out.WriteLine('CANCELLED')
    exit 0
  }
  $ms = $rec.Stop($Out)
  [Console]::Out.WriteLine('DONE ' + $ms)
  exit 0
} catch {
  try { $rec.Abort() } catch { }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
