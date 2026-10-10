---
title: "一次 zsh 啓動體檢，順便説清 .zshrc、oh-my-zsh 和 powerlevel10k 各管什麼"
description: "一台日常開發用的 Mac，新開終端要等半秒。用 zprof 量下來，近八成時間花在 conda 的 shell hook 上，另有一個安裝腳本讓 compinit 多跑了一遍。把 conda 改成按需加載、把補全目錄挪到 oh-my-zsh 前面，啓動降到 0.07 秒。文中給出三層配置的分工、量法、改法，以及一個會把 powerlevel10k 測出假數字的坑。"
date: 2026-10-10
tags: [zsh, oh-my-zsh, powerlevel10k, shell, dev-environment, macos]
draft: true
lang: zh
---

我們有一台日常開發用的 Mac，終端是 iTerm2 加 zsh，提示符用 powerlevel10k。新開一個 tab 要等半秒才能敲字。半秒聽着不多，一天開幾十個 tab 就很煩，而且這種慢是慢慢長出來的，裝一個工具加兩行，裝另一個再加三行，沒有哪一次讓人覺得該停下來看看。

這次停下來看了。量完的結果是這樣。

| 項 | 改前 | 改後 |
|---|---|---|
| `zsh -i -c exit` 耗時 | 0.50 s | 0.07 s |
| 最大單項 | conda shell hook，約 230 ms | 已按需加載 |
| compinit 次數 | 2 | 1 |

下面按實際做的順序寫。先講三層配置各自負責什麼，因為不分清這個，很多「優化」會改在錯的層上。然後講怎麼量，最後講改了哪幾處、為什麼能改。

## 從零裝起

一台新 Mac 到能跑上面這套環境，命令如下。

```sh
# Homebrew
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

# iTerm2
brew install --cask iterm2

# FiraCode Nerd Font
brew install --cask font-fira-code-nerd-font

# oh-my-zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

# powerlevel10k
git clone --depth=1 https://github.com/romkatv/powerlevel10k.git \
  ${ZSH_CUSTOM:-$HOME/.oh-my-zsh/custom}/themes/powerlevel10k
sed -i '' 's/^ZSH_THEME=.*/ZSH_THEME="powerlevel10k\/powerlevel10k"/' ~/.zshrc

# zsh-syntax-highlighting
brew install zsh-syntax-highlighting
echo 'source /opt/homebrew/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh' >> ~/.zshrc
```

macOS 的默認 shell 已經是 zsh，不用另外切。裝完在 iTerm2 的 Profiles 裏把字體換成剛裝的 Nerd Font，重開一個終端（或者在當前終端 `exec zsh`），powerlevel10k 的配置嚮導會自動彈出來。

## 三層配置各管什麼

一個典型的 oh-my-zsh 加 powerlevel10k 環境，交互式 shell 啓動時會依次讀這幾樣。

`~/.zshenv` 每個 zsh 進程都讀，包括腳本和 `zsh -c`。這裏只放 PATH 一類必須對非交互 shell 也生效的設置。我們這台機器上它除了 source 一下 `~/.cargo/env`，就只做一件事，把 Homebrew 裝的 rustup 的 shim 目錄放到 `~/.cargo/bin` 前面，否則舊版 rustup 留下的死鏈接會搶先。這條放在 `.zshrc` 裏就會漏掉編輯器和 CI 起的 shell，所以它必須在 `.zshenv`。

`~/.zshrc` 只有交互式 shell 讀。oh-my-zsh 的入口、主題選擇、插件列表、別名、各種工具安裝腳本追加的環境變量，都在這裏。它是三層裏最容易長胖的一層，因為幾乎所有安裝程序都默認往它末尾追加。

`~/.oh-my-zsh/oh-my-zsh.sh` 由 `.zshrc` 裏那行 `source $ZSH/oh-my-zsh.sh` 拉起。它負責加載 `lib/` 下的基礎函數、按 `plugins=()` 加載插件、按 `ZSH_THEME` 加載主題，還有一件常被忽略的事，它會自己跑 `compinit` 初始化補全系統。我們只開了一個插件 `git`，語法高亮走 Homebrew 裝的那份，`custom/plugins/` 裏 clone 過 zsh-autosuggestions 但沒啓用。

`~/.p10k.zsh` 是 powerlevel10k 的配置，由 `.zshrc` 末尾 `source` 進來。它決定提示符裏顯示什麼、怎麼截斷目錄、git 狀態怎麼畫。這一層和啓動速度的關係後面單獨講。

## 先量，再改

兩個工具就夠。

第一個是 `time`。在 shell 裏跑幾遍，看交互式 shell 從啓動到退出要多久。

```sh
for i in 1 2 3; do /usr/bin/time -p zsh -i -c exit; done
```

我們量到的是 0.50 秒上下。作為對照，`zsh -f -c exit` 跳過所有配置文件，耗時 0.00 秒。也就是説這半秒全部是配置文件花掉的。

第二個是 zsh 自帶的 `zprof` 模塊。在 `.zshrc` 最前面加 `zmodload zsh/zprof`，最末尾加 `zprof`，新開一個 shell 就能看到每個函數的耗時。不想改 `.zshrc` 的話，寫個三行腳本也行。

```sh
# profile.zsh
zmodload zsh/zprof
source ~/.zshrc
zprof | head -20
```

```sh
zsh -c 'source profile.zsh'
```

腳本這條路有一個副作用。`zsh -c` 起的 shell 和交互 shell 的 `fpath` 不完全一樣，oh-my-zsh 可能因此重建一次補全緩存，表裏會多出 `compdump` 和幾百次 `compdef`，那是測量本身帶來的，不是 `.zshrc` 的常態開銷。要看常態數字，還是用寫進 `.zshrc` 的辦法。

我們這台機器在改之前跑出來的前幾行是這樣，單位毫秒。

```text
num  calls   time      self     name
 1)    1   229.70   229.68   __conda_activate
 2)   22    20.81    18.66   _omz_source
 3)    2    15.05    15.05   compaudit
 4)    2    27.44    12.39   compinit
 5)    1     3.62     3.62   _p9k_init_ssh
 6)    1     7.52     3.61   (anon) [powerlevel10k.zsh-theme:50]
```

zprof 統計到的總時間約 290 毫秒，`__conda_activate` 一項 230 毫秒。第二行 `_omz_source` 是 oh-my-zsh 加載 22 個 lib 和插件文件的總和，20 毫秒，正常。第四行 `compinit` 的 calls 列是 2，這個數字後面會用到。`compaudit` 的兩次是 oh-my-zsh 自己的安全檢查加 `compinit` 內部的一次，屬於常態。powerlevel10k 自己的初始化加起來十來毫秒。

## conda 的 shell hook

`conda init zsh` 會往 `.zshrc` 裏寫一段固定格式的代碼，開頭是 `>>> conda initialize >>>`。去掉 fallback 分支，它是這樣。

```sh
__conda_setup="$('/opt/homebrew/Caskroom/miniconda/base/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    # hook 拿不到時退回 conda.sh 或直接改 PATH，略
fi
unset __conda_setup
```

每開一個 shell，它都要起一個 Python 進程，讓 conda 吐出一段 shell 函數定義，再 `eval` 進來。我們的 conda 配置裏 `auto_activate` 是開着的，所以 hook 末尾還帶一句 `conda activate base`，再走一遍激活流程。230 毫秒就是這兩步加起來。

最乾淨的路是從一開始就不跑 `conda init`，每個項目的命令都用 `conda run -n <env>` 包起來執行。這是我們內部的默認做法，文末 optional 一節會展開。這台機器已經 init 過，`python` 指向 base 這件事日常在用，拔掉要改一圈習慣，所以這裏選的是留着它，把它變便宜。

做法是把 hook 改成按需加載。思路是，激活 base 之後 shell 裏多出來的，其實只是一組固定的環境變量和一段 PATH 前綴，這些可以直接寫死，不需要每次讓 Python 算一遍。真正需要 conda 那套函數的時候，也就是第一次敲 `conda` 命令的時候，再把 hook 加載進來。

```sh
# >>> conda (lazy) >>>
export _CONDA_ROOT='/opt/homebrew/Caskroom/miniconda/base'
export CONDA_EXE="$_CONDA_ROOT/bin/conda"
export _CONDA_EXE="$CONDA_EXE"
export CONDA_PYTHON_EXE="$_CONDA_ROOT/bin/python"
export CONDA_PREFIX="$_CONDA_ROOT"
export CONDA_SHLVL=1
export CONDA_DEFAULT_ENV=base
export CONDA_PROMPT_MODIFIER='(base) '
export _CE_M='' _CE_CONDA=''
export PATH="$_CONDA_ROOT/bin:$_CONDA_ROOT/condabin:$PATH"
conda() {
  unfunction conda
  eval "$("$CONDA_EXE" shell.zsh hook 2>/dev/null)"
  conda "$@"
}
# <<< conda (lazy) <<<
```

這組變量的值從哪來。讓 conda 自己説。

```sh
CONDA_SHLVL=0 conda shell.zsh activate base
```

它會打印出激活 base 時要執行的所有賦值，值從這裏取。其中 `PS1` 不用管，powerlevel10k 會接管提示符；它打印的 `PATH` 是展開後的完整值，只取 conda 加在前面的那兩段就夠。路徑按自己機器上 miniconda 的位置換。

`CONDA_SHLVL=1` 這一行有一個額外作用。真 hook 的末尾固定帶一句 `conda activate base`，不管當時在不在 base 裏都會執行。我們預先把 `CONDA_SHLVL` 設成 1、`CONDA_PREFIX` 指向 base，第一次調 `conda` 時真 hook 加載進來，那句 `activate base` 變成對已經激活的 base 做一次重激活，棧深度保持 1，不會疊成兩層。代價是第一次調 `conda` 時多起一個 Python 進程，之後 `conda activate` 別的環境、`conda deactivate`，走的都是真 hook 的函數，行為和原來一樣。

驗證方法是開一個乾淨的 shell，依次確認 `which python` 指向 base，`conda --version` 能觸發加載，`conda activate <env>` 和 `conda deactivate` 之後 PATH 和 `CONDA_SHLVL` 的變化正確。我們三項都過了。

有一個坑要提前説。如果以後再跑一次 `conda init zsh`，它會在 `.zshrc` 末尾再追加一段原版 hook。那時刪掉它追加的那段，保留這段即可。

## compinit 跑了兩遍

回到 zprof 那張表，`compinit` 的 calls 是 2。

`compinit` 是 zsh 補全系統的初始化函數。它要掃一遍 `fpath` 裏所有目錄，收集 `_` 開頭的補全定義，生成一個緩存文件 `.zcompdump`。`compaudit` 是它內部做的安全檢查，看這些目錄有沒有被別的用户可寫，兩樣裏花時間的主要是它。

第二遍是哪來的。翻 `.zshrc` 找到了。

```sh
# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<
```

一個 CLI 工具的安裝腳本，為了讓自己的補全生效，往 `.zshrc` 末尾追加了 `fpath` 和一次 `compinit -C`。它的問題在位置。oh-my-zsh 在前面已經跑過一次 `compinit`，這段又在後面跑了一次。第二次還寫進了另一個 dump 文件，默認位置 `~/.zcompdump`，oh-my-zsh 用的那份帶主機名後綴，兩份互不相干。

安裝腳本這麼寫不算錯，它不知道用户用不用 oh-my-zsh。該改的是我們這邊。

先把賬算清楚。第二次 `compinit -C` 的 `-C` 跳過了安全檢查，自身只有幾毫秒，這一處省下的時間很少，大頭在 conda。改它主要是為了只留一次 `compinit`、一份 dump 文件，補全目錄統一登記在 oh-my-zsh 那份裏。

改法是把 `fpath` 那行挪到 `source $ZSH/oh-my-zsh.sh` 之前，把 `compinit` 那行刪掉。

```sh
plugins=(git)

fpath=(~/.grok/completions/zsh $fpath)

source $ZSH/oh-my-zsh.sh
```

oh-my-zsh 近期的版本會在 dump 文件裏記一份 `fpath` 的指紋，`fpath` 變了它會自動重新生成。所以改完後第一次開 shell 會慢一次，我們量到 0.47 秒，之後就是 0.07 秒。

順手清掉了三個過期的 `.zcompdump` 文件。兩個是歷史遺留，舊主機名寫的那份和某次中斷留下的臨時文件，第三個就是剛才多餘的 `compinit` 寫的。oh-my-zsh 用的是 `~/.zcompdump-<主機名>-<zsh 版本>` 這個命名，只留它和它的 `.zwc` 編譯版就夠。

## powerlevel10k 這一層

powerlevel10k 的配置文件有一千七百多行，幾乎全是 `p10k configure` 生成的。我們原本擔心右側提示符那四十七個段會拖慢每一次回車，量完發現不用擔心。

先説三個和速度直接相關的設置，前兩個在文件末尾，第三個在中間。

`POWERLEVEL9K_INSTANT_PROMPT=verbose`。開着。它的做法是在 `.zshrc` 開頭就先把上一次緩存好的提示符畫出來，讓用户立刻能看到光標，後面的初始化在背後繼續。這是為什麼 powerlevel10k 要求那段 instant prompt 代碼儘量靠近 `.zshrc` 頂部。它只改善觀感，`.zshrc` 沒跑完之前敲的命令還是要等。conda 那 230 毫秒照樣擋在前面。

`POWERLEVEL9K_DISABLE_HOT_RELOAD=true`。開着。hot reload 開着時，powerlevel10k 每次畫提示符前都會把所有 `POWERLEVEL9K_*` 參數算一個簽名，和上次比對，變了就重新初始化，配置文件裏的註釋説這要多花一兩毫秒。關掉以後省下這一步，改了配置要 `p10k reload` 或重開終端才生效。

`POWERLEVEL9K_VCS_DISABLED_WORKDIR_PATTERN='~'`。這條讓 git 狀態段在家目錄本身關閉，子目錄不受影響。有人會把整個家目錄做成 git 倉庫來管 dotfiles，那種倉庫很大，狀態也沒什麼可看的，在那裏算 git 狀態是純浪費。

git 狀態本身由一個叫 `gitstatusd` 的後台進程算，powerlevel10k 第一次運行時會把二進制下載到 `~/.cache/gitstatus/`。它是異步的，提示符先畫出來，git 信息算好以後再補上去，所以倉庫再大也不會卡住回車。

至於那四十七個段，`asdf`、`nvm`、`pyenv`、`kubectl`、`aws` 這類工具這台機器上一個都沒裝。每個段帶一個很便宜的存在性條件，就是一次參數展開，工具不在就什麼都不渲染。留着不花錢。

量法是在一個真實終端裏，連續調 20 次 `_p9k_precmd`，再看 zprof。

```sh
zmodload zsh/zprof; zprof -c
for i in {1..20}; do _p9k_precmd; done
zprof | head
```

在一個 git 倉庫目錄下，每次提示符渲染約 4 毫秒。沒什麼可改的。

這裏有一個坑，我們自己先踩了一遍。第一次測的時候圖省事，用 `zsh -i -c '...'` 直接跑上面那段，結果 `VCS_INFO_get_data_git` 一項每次 130 毫秒，看起來像是 git 段嚴重拖慢。實際原因是 `zsh -i -c` 沒有分配終端，`gitstatusd` 起不來，powerlevel10k 退回到 zsh 自帶的同步 `vcs_info` 後端，那個後端每次都要 fork 好幾個 `git` 進程。同一段測試用 `script -q /dev/null zsh -i -c '...'` 包一層偽終端再跑，數字就回到 4 毫秒。測提示符性能，一定要在有 tty 的環境裏測。

## 剩下的兩處小改

一行 `PYTORCH_ENABLE_MPS_FALLBACK=1`，沒有 `export`。在 `.zshrc` 裏這樣寫只是設了一個 shell 變量，子進程裏的 PyTorch 看不到它，等於沒寫。補上 `export`。這和速度無關，順手修的。

一行 `export TOKEN="$(cat ~/.some/token-file)"`，可以寫成 `$(<~/.some/token-file)`。前者要 fork 一個 `cat`，後者由 zsh 自己讀文件。省的時間不到一毫秒，但這種寫法在 `.zshrc` 裏多了沒好處，看到就改。

## 以後怎麼防

這次慢下來的兩個原因都來自安裝腳本往 `.zshrc` 末尾追加代碼。它們各自都沒錯，疊在一起才出問題。防的辦法只有一個，每隔一段時間把 `zprof` 跑一遍，看第一行是誰。

一台機器的 `.zshrc` 該多快，沒有標準答案。我們這台改完是 0.07 秒，其中 oh-my-zsh 加載 lib 和插件 20 毫秒，`compinit` 連同它裏面的 `compaudit` 二十多毫秒，powerlevel10k 初始化十來毫秒。再往下壓要換掉 oh-my-zsh，我們覺得不值。

## Optional，miniconda 怎麼裝，以及我們怎麼用它

這一節給要跑 Python 項目的人。前面 conda 那一節是補救，機器已經 `conda init` 過了才用。這裏是新機器上我們推薦的裝法。兩條路只能選一條。

```sh
brew install --cask miniconda
```

裝完 miniconda 在 `/opt/homebrew/Caskroom/miniconda/base/`，Homebrew 會把它 `condabin` 裏的 `conda` 鏈到 `/opt/homebrew/bin`，直接能用。不要再跑 `conda init zsh`。

選 miniconda 而不直接用 Homebrew 的 Python，看中的是兩件事。一是它能給每個項目一個獨立環境，Python 版本各自指定，互不影響，系統和 Homebrew 的 Python 一個都不碰。二是環境之間的切換可以完全不經過 shell，這正是我們不跑 `conda init` 的前提。

我們內部的 Python 項目都按下面這套走。

```sh
# 每個項目一個環境，Python 版本在這裏定
conda create -n <env_name> python=3.12

# 環境裏先裝 uv，之後包管理全交給它
conda run -n <env_name> pip install uv

# 裝庫
conda run -n <env_name> uv pip install python-dotenv playwright

# 帶 CLI 的工具用 uv tool，保證命令全局可用
uv tool install crewai

# 跑項目
conda run -n <env_name> python main.py
```

規則只有四條。

- 不在全局 Python 下跑任何項目，每個項目必須有自己的環境。
- 包用 `uv pip` 裝，CLI 工具用 `uv tool` 裝。uv 並行下載加硬鏈接，裝一個環境是秒級的事，pip 是分鐘級。
- 不跑 `conda init`，不 `conda activate`，環境內的一切操作都寫成 `conda run -n <env_name> <command>`。理由就是本文前半篇，conda 一旦進了 `.zshrc`，每個 shell 都要替它付錢，多個 Python 路徑疊在 PATH 上還會出現命令被意外攔截的問題。
- 密鑰、RPC 地址這類配置放項目目錄的 `.env`，列進 `.gitignore`，不進 `.zshrc`，也不進代碼。

`conda run` 有一個行為要知道。它默認會緩衝子進程的輸出，跑長時間任務時日誌可能攢到結束才一起出來，加 `--no-capture-output` 就恢復實時輸出。

---

*由 Henry Lin 提示，Fable 5.1 撰寫。*
