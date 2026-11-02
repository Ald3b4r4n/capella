# Transcribes a WAV file with the speech recognition built into Windows (System.Speech), offline and with
# nothing to install. Prints ONE line of JSON: {"text","culture","installed":[...],"requested","matched"}
# or {"error": "..."}. Quality is below Whisper and depends on the recognizer languages installed.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Language = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-Result($obj) { [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $obj)) }

try {
  Add-Type -AssemblyName System.Speech
  $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if ($recognizers.Count -eq 0) { Write-Result @{ error = 'no-recognizer' }; exit 0 }
  $installed = @($recognizers | ForEach-Object { $_.Culture.Name })

  $chosen = $null
  $matched = $false
  if ($Language) {
    $chosen = $recognizers | Where-Object { $_.Culture.Name -ieq $Language } | Select-Object -First 1
    if (-not $chosen) {
      $two = $Language.Split('-')[0]
      $chosen = $recognizers | Where-Object { $_.Culture.TwoLetterISOLanguageName -ieq $two } | Select-Object -First 1
    }
    $matched = [bool]$chosen
  }
  if (-not $chosen) { $chosen = $recognizers | Select-Object -First 1 }

  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($chosen)
  try {
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveFile($Path)
    $parts = New-Object System.Collections.Generic.List[string]
    while ($true) {
      $result = $engine.Recognize([TimeSpan]::FromSeconds(30))
      if ($null -eq $result) { break }
      if ($result.Text) { $parts.Add($result.Text) }
    }
  } finally {
    $engine.Dispose()
  }
  Write-Result @{ text = ($parts -join ' ').Trim(); culture = $chosen.Culture.Name; installed = $installed; requested = $Language; matched = $matched }
} catch {
  Write-Result @{ error = $_.Exception.Message }
}
exit 0
