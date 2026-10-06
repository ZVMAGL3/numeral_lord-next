param(
  [Parameter(Mandatory = $true)]
  [ValidateRange(2, 1000000)]
  [int]$StartIteration,

  [Parameter(Mandatory = $true)]
  [string]$CheckpointPath
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $repositoryRoot
$currentCheckpoint = [System.IO.Path]::GetFullPath((Join-Path $repositoryRoot $CheckpointPath))
$iteration = $StartIteration

while ($true) {
  $runName = "hunxiao-selfplay-1000-iteration-$iteration-20261006"
  $runDirectory = Join-Path $PSScriptRoot "runs\$runName"
  if (Test-Path $runDirectory) {
    throw "Iteration $iteration already has a run directory: $runDirectory"
  }

  $seed = 20261013 + $iteration
  $dataPath = Join-Path $runDirectory "samples.jsonl"
  $metadataPath = Join-Path $runDirectory "metadata.json"
  $nextCheckpoint = Join-Path $runDirectory "iteration-$iteration.pt"

  Write-Host "=== Iteration ${iteration}: 1,000 self-play games from $currentCheckpoint ==="
  & pnpm ai selfplay --name $runName --checkpoint $currentCheckpoint --bootstrap network `
    --games 1000 --workers 12 --simulations 16 --min-simulations 4 --think-ms 50 --max-actions 10000 `
    --max-learning-rounds 0 --max-samples 256 --device xpu --seed $seed --league-ratio auto --replay
  if ($LASTEXITCODE -ne 0) { throw "Self-play failed at iteration $iteration (exit $LASTEXITCODE)." }

  Write-Host "=== Iteration ${iteration}: train and save $nextCheckpoint ==="
  & pnpm ai train --data $dataPath --metadata $metadataPath --output $nextCheckpoint `
    --resume $currentCheckpoint --device xpu --steps 1200 --batch-size 64 --seed $seed
  if ($LASTEXITCODE -ne 0) { throw "Training failed at iteration $iteration (exit $LASTEXITCODE)." }
  if (!(Test-Path $nextCheckpoint)) { throw "Training did not create checkpoint $nextCheckpoint." }

  $currentCheckpoint = $nextCheckpoint
  $iteration += 1
}
