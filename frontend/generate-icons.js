import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const svgPath = path.join(__dirname, 'public', 'icons', 'icon.svg');
const outputDir = path.join(__dirname, 'public', 'icons');

const sizes = [16, 32, 48, 72, 96, 128, 144, 152, 192, 384, 512];

async function generateIcons() {
  console.log('开始生成图标...');
  console.log('SVG 路径:', svgPath);
  
  if (!fs.existsSync(svgPath)) {
    console.error('SVG 文件不存在！');
    return;
  }
  
  for (const size of sizes) {
    const outputPath = path.join(outputDir, 'icon-' + size + 'x' + size + '.png');
    
    try {
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(outputPath);
      
      console.log('生成 icon-' + size + 'x' + size + '.png');
    } catch (error) {
      console.error('生成 icon-' + size + 'x' + size + '.png 失败:', error.message);
    }
  }
  
  console.log('图标生成完成！');
}

generateIcons().catch(console.error);
