---
title: "一次 zsh 启动体检，顺便说清 .zshrc、oh-my-zsh 和 powerlevel10k 各管什么"
description: "一台日常开发用的 Mac，新开终端要等半秒。用 zprof 量下来，近八成时间花在 conda 的 shell hook 上，其余是 compinit 跑了两遍。把 conda 改成按需加载、把补全目录挪到 oh-my-zsh 前面，启动降到 0.07 秒。文中给出三层配置的分工、量法、改法，以及一个会把 powerlevel10k 测出假数字的坑。"
date: 2026-10-10
tags: [zsh, oh-my-zsh, powerlevel10k, shell, dev-environment, macos]
draft: true
lang: zh
---

我们有一台日常开发用的 Mac，终端是 iTerm2 加 zsh，提示符用 powerlevel10k。新开一个 tab 要等半秒才能敲字。半秒听着不多，一天开几十个 tab 就很烦，而且这种慢是慢慢长出来的，装一个工具加两行，装另一个再加三行，没有哪一次让人觉得该停下来看看。

这次停下来看了。量完的结果是这样。

| 项 | 改前 | 改后 |
|---|---|---|
| `zsh -i -c exit` 耗时 | 0.50 s | 0.07 s |
| 最大单项 | conda shell hook，约 230 ms | 已按需加载 |
| compinit 次数 | 2 | 1 |

下面按实际做的顺序写。先讲三层配置各自负责什么，因为不分清这个，很多「优化」会改在错的层上。然后讲怎么量，最后讲改了哪几处、为什么能改。

## 从零装起

一台新 Mac 到能跑上面这套环境，命令如下。

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

macOS 的默认 shell 已经是 zsh，不用另外切。装完在 iTerm2 的 Profiles 里把字体换成刚装的 Nerd Font，重开一个终端（或者在当前终端 `exec zsh`），powerlevel10k 的配置向导会自动弹出来。

## 三层配置各管什么

一个典型的 oh-my-zsh 加 powerlevel10k 环境，交互式 shell 启动时会依次读这几样。

`~/.zshenv` 每个 zsh 进程都读，包括脚本和 `zsh -c`。这里只放 PATH 一类必须对非交互 shell 也生效的设置。我们这台机器上它除了 source 一下 `~/.cargo/env`，就只做一件事，把 Homebrew 装的 rustup 的 shim 目录放到 `~/.cargo/bin` 前面，否则旧版 rustup 留下的死链接会抢先。这条放在 `.zshrc` 里就会漏掉编辑器和 CI 起的 shell，所以它必须在 `.zshenv`。

`~/.zshrc` 只有交互式 shell 读。oh-my-zsh 的入口、主题选择、插件列表、别名、各种工具安装脚本追加的环境变量，都在这里。它是三层里最容易长胖的一层，因为几乎所有安装程序都默认往它末尾追加。

`~/.oh-my-zsh/oh-my-zsh.sh` 由 `.zshrc` 里那行 `source $ZSH/oh-my-zsh.sh` 拉起。它负责加载 `lib/` 下的基础函数、按 `plugins=()` 加载插件、按 `ZSH_THEME` 加载主题，还有一件常被忽略的事，它会自己跑 `compinit` 初始化补全系统。我们只开了一个插件 `git`，语法高亮走 Homebrew 装的那份，`custom/plugins/` 里 clone 过 zsh-autosuggestions 但没启用。

`~/.p10k.zsh` 是 powerlevel10k 的配置，由 `.zshrc` 末尾 `source` 进来。它决定提示符里显示什么、怎么截断目录、git 状态怎么画。这一层和启动速度的关系后面单独讲。

## 先量，再改

两个工具就够。

第一个是 `time`。在 shell 里跑几遍，看交互式 shell 从启动到退出要多久。

```sh
for i in 1 2 3; do /usr/bin/time -p zsh -i -c exit; done
```

我们量到的是 0.50 秒上下。作为对照，`zsh -f -c exit` 跳过所有配置文件，耗时 0.00 秒。也就是说这半秒全部是配置文件花掉的。

第二个是 zsh 自带的 `zprof` 模块。在 `.zshrc` 最前面加 `zmodload zsh/zprof`，最末尾加 `zprof`，新开一个 shell 就能看到每个函数的耗时。不想改 `.zshrc` 的话，写个三行脚本也行。

```sh
# profile.zsh
zmodload zsh/zprof
source ~/.zshrc
zprof | head -20
```

```sh
zsh -c 'source profile.zsh'
```

脚本这条路有一个副作用。`zsh -c` 起的 shell 和交互 shell 的 `fpath` 不完全一样，oh-my-zsh 可能因此重建一次补全缓存，表里会多出 `compdump` 和几百次 `compdef`，那是测量本身带来的，不是 `.zshrc` 的常态开销。要看常态数字，还是用写进 `.zshrc` 的办法。

我们这台机器在改之前跑出来的前几行是这样，单位毫秒。

```text
num  calls   time      self     name
 1)    1   229.70   229.68   __conda_activate
 2)   22    20.81    18.66   _omz_source
 3)    2    15.05    15.05   compaudit
 4)    2    27.44    12.39   compinit
 5)    1     3.62     3.62   _p9k_init_ssh
 6)    1     7.52     3.61   (anon) [powerlevel10k.zsh-theme:50]
```

zprof 统计到的总时间约 290 毫秒，`__conda_activate` 一项 230 毫秒。第二行 `_omz_source` 是 oh-my-zsh 加载 22 个 lib 和插件文件的总和，20 毫秒，正常。第四行 `compinit` 的 calls 列是 2，这个数字后面会用到。`compaudit` 的两次是 oh-my-zsh 自己的安全检查加 `compinit` 内部的一次，属于常态。powerlevel10k 自己的初始化加起来十来毫秒。

## conda 的 shell hook

`conda init zsh` 会往 `.zshrc` 里写一段固定格式的代码，开头是 `>>> conda initialize >>>`。去掉 fallback 分支，它是这样。

```sh
__conda_setup="$('/opt/homebrew/Caskroom/miniconda/base/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    # hook 拿不到时退回 conda.sh 或直接改 PATH，略
fi
unset __conda_setup
```

每开一个 shell，它都要起一个 Python 进程，让 conda 吐出一段 shell 函数定义，再 `eval` 进来。我们的 conda 配置里 `auto_activate` 是开着的，所以 hook 末尾还带一句 `conda activate base`，再走一遍激活流程。230 毫秒就是这两步加起来。

最干净的路是从一开始就不跑 `conda init`，每个项目的命令都用 `conda run -n <env>` 包起来执行。这是我们内部的默认做法，文末 optional 一节会展开。这台机器已经 init 过，`python` 指向 base 这件事日常在用，拔掉要改一圈习惯，所以这里选的是留着它，把它变便宜。

做法是把 hook 改成按需加载。思路是，激活 base 之后 shell 里多出来的东西其实是一组固定的环境变量和一段 PATH，这些可以直接写死，不需要每次让 Python 算一遍。真正需要 conda 那套函数的时候，也就是第一次敲 `conda` 命令的时候，再把 hook 加载进来。

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

这组变量的值从哪来。让 conda 自己说。

```sh
CONDA_SHLVL=0 conda shell.zsh activate base
```

它会打印出激活 base 时要执行的所有赋值，值从这里取。其中 `PS1` 不用管，powerlevel10k 会接管提示符；它打印的 `PATH` 是展开后的完整值，只取 conda 加在前面的那两段就够。路径按自己机器上 miniconda 的位置换。

`CONDA_SHLVL=1` 这一行有一个额外作用。真 hook 的末尾固定带一句 `conda activate base`，不管当时在不在 base 里都会执行。我们预先把 `CONDA_SHLVL` 设成 1、`CONDA_PREFIX` 指向 base，第一次调 `conda` 时真 hook 加载进来，那句 `activate base` 变成对已经激活的 base 做一次重激活，栈深度保持 1，不会叠成两层。代价是第一次调 `conda` 时多起一个 Python 进程，之后 `conda activate` 别的环境、`conda deactivate`，走的都是真 hook 的函数，行为和原来一样。

验证方法是开一个干净的 shell，依次确认 `which python` 指向 base，`conda --version` 能触发加载，`conda activate <env>` 和 `conda deactivate` 之后 PATH 和 `CONDA_SHLVL` 的变化正确。我们三项都过了。

有一个坑要提前说。如果以后再跑一次 `conda init zsh`，它会在 `.zshrc` 末尾再追加一段原版 hook。那时删掉它追加的那段，保留这段即可。

## compinit 跑了两遍

回到 zprof 那张表，`compinit` 的 calls 是 2。

`compinit` 是 zsh 补全系统的初始化函数。它要扫一遍 `fpath` 里所有目录，收集 `_` 开头的补全定义，生成一个缓存文件 `.zcompdump`。`compaudit` 是它内部做的安全检查，看这些目录有没有被别的用户可写，是这两样里真正花时间的部分。

第二遍是哪来的。翻 `.zshrc` 找到了。

```sh
# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<
```

一个 CLI 工具的安装脚本，为了让自己的补全生效，往 `.zshrc` 末尾追加了 `fpath` 和一次 `compinit -C`。它的问题在位置。oh-my-zsh 在前面已经跑过一次 `compinit`，这段又在后面跑了一次。第二次还写进了另一个 dump 文件，默认位置 `~/.zcompdump`，oh-my-zsh 用的那份带主机名后缀，两份互不相干。

安装脚本这么写不算错，它不知道用户用不用 oh-my-zsh。该改的是我们这边。

先把账算清楚。第二次 `compinit -C` 的 `-C` 跳过了安全检查，自身只有几毫秒，这一处省下的时间很少，大头在 conda。改它主要是为了只留一次 `compinit`、一份 dump 文件，补全目录统一登记在 oh-my-zsh 那份里。

改法是把 `fpath` 那行挪到 `source $ZSH/oh-my-zsh.sh` 之前，把 `compinit` 那行删掉。

```sh
plugins=(git)

fpath=(~/.grok/completions/zsh $fpath)

source $ZSH/oh-my-zsh.sh
```

oh-my-zsh 近期的版本会在 dump 文件里记一份 `fpath` 的指纹，`fpath` 变了它会自动重新生成。所以改完后第一次开 shell 会慢一次，我们量到 0.47 秒，之后就是 0.07 秒。

顺手清掉了三个过期的 `.zcompdump` 文件。两个是历史遗留，旧主机名写的那份和某次中断留下的临时文件，第三个就是刚才多余的 `compinit` 写的。oh-my-zsh 用的是 `~/.zcompdump-<主机名>-<zsh 版本>` 这个命名，只留它和它的 `.zwc` 编译版就够。

## powerlevel10k 这一层

powerlevel10k 的配置文件有一千七百多行，几乎全是 `p10k configure` 生成的。我们原本担心右侧提示符那四十七个段会拖慢每一次回车，量完发现不用担心。

先说三个和速度直接相关的设置，前两个在文件末尾，第三个在中间。

`POWERLEVEL9K_INSTANT_PROMPT=verbose`。开着。它的做法是在 `.zshrc` 开头就先把上一次缓存好的提示符画出来，让用户立刻能看到光标，后面的初始化在背后继续。这是为什么 powerlevel10k 要求那段 instant prompt 代码尽量靠近 `.zshrc` 顶部。它只改善观感，`.zshrc` 没跑完之前敲的命令还是要等。conda 那 230 毫秒照样挡在前面。

`POWERLEVEL9K_DISABLE_HOT_RELOAD=true`。开着。hot reload 开着时，powerlevel10k 每次画提示符前都会把所有 `POWERLEVEL9K_*` 参数算一个签名，和上次比对，变了就重新初始化，配置文件里的注释说这要多花一两毫秒。关掉以后省下这一步，改了配置要 `p10k reload` 或重开终端才生效。

`POWERLEVEL9K_VCS_DISABLED_WORKDIR_PATTERN='~'`。这条让 git 状态段在家目录本身关闭，子目录不受影响。有人会把整个家目录做成 git 仓库来管 dotfiles，那种仓库又大又没什么可看的状态，在那里算 git 状态是纯浪费。

git 状态本身由一个叫 `gitstatusd` 的后台进程算，powerlevel10k 第一次运行时会把二进制下载到 `~/.cache/gitstatus/`。它是异步的，提示符先画出来，git 信息算好以后再补上去，所以仓库再大也不会卡住回车。

至于那四十七个段，`asdf`、`nvm`、`pyenv`、`kubectl`、`aws` 这类工具这台机器上一个都没装。每个段带一个很便宜的存在性条件，就是一次参数展开，工具不在就什么都不渲染。留着不花钱。

量法是在一个真实终端里，连续调 20 次 `_p9k_precmd`，再看 zprof。

```sh
zmodload zsh/zprof; zprof -c
for i in {1..20}; do _p9k_precmd; done
zprof | head
```

在一个 git 仓库目录下，每次提示符渲染约 4 毫秒。没什么可改的。

这里有一个坑，我们自己先踩了一遍。第一次测的时候图省事，用 `zsh -i -c '...'` 直接跑上面那段，结果 `VCS_INFO_get_data_git` 一项每次 130 毫秒，看起来像是 git 段严重拖慢。实际原因是 `zsh -i -c` 没有分配终端，`gitstatusd` 起不来，powerlevel10k 退回到 zsh 自带的同步 `vcs_info` 后端，那个后端每次都要 fork 好几个 `git` 进程。同一段测试用 `script -q /dev/null zsh -i -c '...'` 包一层伪终端再跑，数字就回到 4 毫秒。测提示符性能，一定要在有 tty 的环境里测。

## 剩下的两处小改

一行 `PYTORCH_ENABLE_MPS_FALLBACK=1`，没有 `export`。在 `.zshrc` 里这样写只是设了一个 shell 变量，子进程里的 PyTorch 看不到它，等于没写。补上 `export`。这和速度无关，顺手修的。

一行 `export TOKEN="$(cat ~/.some/token-file)"`，可以写成 `$(<~/.some/token-file)`。前者要 fork 一个 `cat`，后者由 zsh 自己读文件。省的时间不到一毫秒，但这种写法在 `.zshrc` 里多了没好处，看到就改。

## 以后怎么防

这次慢下来的两个原因都来自安装脚本往 `.zshrc` 末尾追加代码。它们各自都没错，叠在一起才出问题。防的办法只有一个，每隔一段时间把 `zprof` 跑一遍，看第一行是谁。

一台机器的 `.zshrc` 该多快，没有标准答案。我们这台改完是 0.07 秒，其中 oh-my-zsh 加载 lib 和插件 20 毫秒，`compinit` 连同它里面的 `compaudit` 二十多毫秒，powerlevel10k 初始化十来毫秒。再往下压要换掉 oh-my-zsh，我们觉得不值。

## Optional，miniconda 怎么装，以及我们怎么用它

这一节给要跑 Python 项目的人。前面 conda 那一节是补救，机器已经 `conda init` 过了才用。这里是新机器上我们推荐的装法。两条路只能选一条。

```sh
brew install --cask miniconda
```

装完 miniconda 在 `/opt/homebrew/Caskroom/miniconda/base/`，Homebrew 会把它 `condabin` 里的 `conda` 链到 `/opt/homebrew/bin`，直接能用。不要再跑 `conda init zsh`。

选 miniconda 而不直接用 Homebrew 的 Python，看中的是两件事。一是它能给每个项目一个独立环境，Python 版本各自指定，互不影响，系统和 Homebrew 的 Python 一个都不碰。二是环境之间的切换可以完全不经过 shell，这正是我们不跑 `conda init` 的前提。

我们内部的 Python 项目都按下面这套走。

```sh
# 每个项目一个环境，Python 版本在这里定
conda create -n <env_name> python=3.12

# 环境里先装 uv，之后包管理全交给它
conda run -n <env_name> pip install uv

# 装库
conda run -n <env_name> uv pip install python-dotenv playwright

# 带 CLI 的工具用 uv tool，保证命令全局可用
uv tool install crewai

# 跑项目
conda run -n <env_name> python main.py
```

规则只有四条。

- 不在全局 Python 下跑任何项目，每个项目必须有自己的环境。
- 包用 `uv pip` 装，CLI 工具用 `uv tool` 装。uv 并行下载加硬链接，装一个环境是秒级的事，pip 是分钟级。
- 不跑 `conda init`，不 `conda activate`，环境内的一切操作都写成 `conda run -n <env_name> <command>`。理由就是本文前半篇，conda 一旦进了 `.zshrc`，每个 shell 都要替它付钱，多个 Python 路径叠在 PATH 上还会出现命令被意外拦截的问题。
- 密钥和 RPC 地址一类的东西放项目目录的 `.env`，列进 `.gitignore`，不进 `.zshrc`，也不进代码。

`conda run` 有一个使用上的小差别要知道。它默认会缓冲子进程的输出，跑长时间任务时日志可能攒到结束才一起出来，加 `--no-capture-output` 就恢复实时输出。

---

*由 Henry Lin 提示，Fable 5.1 撰写。*
