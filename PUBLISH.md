# 发布与更新

这份文件给仓库维护者看，普通使用者看 `README.md`。

## 1. 在 GitHub 建仓库

打开 <https://github.com/new>：

- Repository name 填 `st-auto-summary`
- 可见性按需（公开的话手机端安装不需要登录）
- 不要勾选自动生成 README / .gitignore / License

## 2. 推送到 GitHub

```bash
git remote add origin https://github.com/bingfengsuiying/st-auto-summary.git
git branch -M main
git push -u origin main
git push origin --tags
```

密码位置填 Personal Access Token（需要 `repo` 权限），或改用 SSH。

## 3. 发版本

```bash
git tag -a v1.0.0 -m "剧情自动总结 v1.0.0"
git push origin v1.0.0
```

GitHub → Releases → Draft a new release，选择该 tag，可把 `st-auto-summary-1.1.0.zip` 作为附件上传。

## 4. 手机拉取

酒馆内：扩展 → Install extension → `https://github.com/bingfengsuiying/st-auto-summary`

Termux：

```bash
cd ~/SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/bingfengsuiying/st-auto-summary.git
# 更新
cd st-auto-summary && git pull
```

## 5. 日常更新

```bash
git add -A
git commit -m "fix: 说明改了什么"
git push
```
