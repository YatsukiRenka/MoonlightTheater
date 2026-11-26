# Self-hosted fonts

These fonts are subsets of the variable fonts in the Google Fonts repository.

- Noto Serif SC comes from `google/fonts/ofl/notoserifsc/NotoSerifSC[wght].ttf`.
- Cormorant Garamond comes from `google/fonts/ofl/cormorantgaramond/CormorantGaramond[wght].ttf`.
- Cormorant Garamond italic comes from `google/fonts/ofl/cormorantgaramond/CormorantGaramond-Italic[wght].ttf`.

All fonts are licensed under the SIL Open Font License 1.1. The accompanying `OFL-NotoSerifSC.txt` and `OFL-CormorantGaramond.txt` files contain the license texts.

## Character coverage

`noto-serif-sc-display.woff2` contains these Chinese characters:

```text
月光剧场角色提示词生成器创作台设计库历史记录设置本地工作区成图片素材与抽取权重生资源上限备份云端风格分支配方案体态轮廓面部特征发型色瞳表情服装头饰非人袜鞋随身道具姿势绘制画展示形式评价喜欢一般不选择导入式高级添加编辑解密预览从中关闭今夜开演第二三四五六七八九十幕序终号目戏单影后间锁定星隐私政策务条款探索度机种子全新卷帙页集期时刻分秒年日〇零主保完整留
```

It also contains digits and `·`. Its variable `wght` axis ranges from 500 to 900.

`cormorant.woff2` and `cormorant-italic.woff2` are subset from their respective upright and italic faces with `wght` limited to 400–600. The Unicode input for both subsets is ASCII U+0020–U+007E plus `º`, `ª`, `·`, `æ`, `Æ`, `œ`, `é`, `è`, `–`, `—`, `‘`, `’`, `“`, `”`, `…`, and `№`.

Heading characters outside these subsets fall back to the next serif in the CSS font stack. Re-subset the fonts when heading text changes so the intended display faces cover every heading character.
