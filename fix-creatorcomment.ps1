$f = 'd:\项目\Palink-AI\frontend\src\components\views\character\CharacterChat.tsx'
$content = [System.IO.File]::ReadAllText($f, [System.Text.UTF8Encoding]::new($false))
$old = 'creatorcomment: selectedCharacter.creator_notes || '','
$new = 'creator_notes: selectedCharacter.creator_notes || '','
$count = ([regex]::Matches($content, [regex]::Escape('creatorcomment:'))).Count
Write-Host "Before replace - creatorcomment count: $count"
$newContent = $content.Replace($old, $new)
$countAfter = ([regex]::Matches($newContent, [regex]::Escape('creatorcomment:'))).Count
Write-Host "After replace - creatorcomment count: $countAfter"
[System.IO.File]::WriteAllText($f, $newContent, [System.Text.UTF8Encoding]::new($false))
Write-Host "File written successfully"
