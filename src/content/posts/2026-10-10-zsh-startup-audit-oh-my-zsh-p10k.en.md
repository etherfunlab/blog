---
title: "A zsh Startup Audit, and What .zshrc, oh-my-zsh and powerlevel10k Each Do"
description: "A daily-driver Mac took half a second to open a new terminal tab. zprof put nearly 80% of that on conda's shell hook, with the rest going to compinit running twice. Lazy-loading conda and moving a completions directory ahead of oh-my-zsh brought startup to 0.07 s. This post covers what the three config layers are for, how to measure, what we changed, and a trap that makes powerlevel10k look slow when it isn't."
date: 2026-10-10
tags: [zsh, oh-my-zsh, powerlevel10k, shell, dev-environment, macos]
draft: true
lang: en
---

We have a Mac we use for daily development. The terminal is iTerm2 with zsh, the prompt is powerlevel10k. Opening a new tab meant waiting half a second before typing. Half a second does not sound like much, but it adds up over a few dozen tabs a day, and this kind of slowness grows gradually. One tool's installer appends two lines, the next appends three, and no single step ever feels like the moment to stop and look.

This time we stopped and looked. The numbers came out like this.

| | Before | After |
|---|---|---|
| `zsh -i -c exit` | 0.50 s | 0.07 s |
| Largest single item | conda shell hook, ~230 ms | lazy-loaded |
| compinit runs | 2 | 1 |

What follows is in the order we actually did it. First, what each of the three config layers is responsible for, because without that distinction a lot of "optimizations" land in the wrong layer. Then how to measure. Then what we changed and why each change was safe.

## From a blank Mac

The commands to get from a fresh macOS install to the environment described here.

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

macOS already ships zsh as the default shell, so there is nothing to switch. Set the font in iTerm2's profile to the Nerd Font you just installed, open a new terminal (or `exec zsh` in the current one), and the powerlevel10k configuration wizard starts on its own.

## What each layer does

A typical oh-my-zsh plus powerlevel10k setup reads these files, in this order, when an interactive shell starts.

`~/.zshenv` is read by every zsh process, including scripts and `zsh -c`. Only things that must also apply to non-interactive shells belong here, PATH above all. On this machine it does exactly one thing. It puts the shim directory of Homebrew's rustup ahead of `~/.cargo/bin`, because dead symlinks left by an older rustup install would otherwise win. Putting that line in `.zshrc` would miss the shells started by editors and CI, so it has to live in `.zshenv`.

`~/.zshrc` is read by interactive shells only. The oh-my-zsh entry point, the theme choice, the plugin list, aliases, and every environment variable appended by some tool's installer all live here. It is the layer that gains weight most easily, because nearly every installer defaults to appending to the end of it.

`~/.oh-my-zsh/oh-my-zsh.sh` is pulled in by the `source $ZSH/oh-my-zsh.sh` line in `.zshrc`. It loads the base functions under `lib/`, loads whatever is in `plugins=()`, loads the theme named by `ZSH_THEME`, and does one thing that is easy to overlook. It runs `compinit` itself to initialize the completion system. We have exactly one plugin enabled, `git`. Syntax highlighting comes from the Homebrew package. There is a clone of zsh-autosuggestions under `custom/plugins/` that is not enabled.

`~/.p10k.zsh` is powerlevel10k's configuration, sourced at the end of `.zshrc`. It decides what the prompt shows, how directories are truncated, how git status is drawn. Its relationship to startup time gets its own section below.

## Measure first

Two tools are enough.

The first is `time`. Run it a few times and see how long an interactive shell takes from start to exit.

```sh
for i in 1 2 3; do /usr/bin/time -p zsh -i -c exit; done
```

We measured around 0.50 s. For comparison, `zsh -f -c exit` skips every config file and takes 0.00 s. The entire half second is config.

The second is zsh's built-in `zprof` module. Put `zmodload zsh/zprof` at the very top of `.zshrc` and `zprof` at the very bottom, open a new shell, and you get per-function timings. If you would rather not touch `.zshrc`, a three-line script does the same.

```sh
# profile.zsh
zmodload zsh/zprof
source ~/.zshrc
zprof | head -20
```

```sh
zsh -c 'source profile.zsh'
```

The top of the output on this machine, in milliseconds.

```text
num  calls   time      self     name
 1)    1   229.70   229.68   __conda_activate
 2)   22    20.81    18.66   _omz_source
 3)    2    15.05    15.05   compaudit
 4)    2    27.44    12.39   compinit
 5)    1     3.62     3.62   _p9k_init_ssh
 6)    1     7.52     3.61   (anon) [powerlevel10k.zsh-theme:50]
```

zprof accounted for about 290 ms in total, and `__conda_activate` alone was 230 ms of it. The second row, `_omz_source`, is oh-my-zsh loading 22 lib and plugin files. Twenty milliseconds, which is normal. Rows three and four, `compaudit` and `compinit`, both show 2 in the calls column. That number comes back later. powerlevel10k's own initialization adds up to a little over ten milliseconds.

## conda's shell hook

`conda init zsh` writes a fixed block into `.zshrc`, delimited by `>>> conda initialize >>>`. Its core is this line.

```sh
__conda_setup="$('/opt/homebrew/Caskroom/miniconda/base/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
eval "$__conda_setup"
```

Every new shell starts a Python process, has conda print a set of shell function definitions, and `eval`s them. Our conda config has `auto_activate` on, so the hook also ends with `conda activate base`, which runs the activation path once more. The 230 ms is those two steps together.

The cleanest route is to never run `conda init` at all and to wrap every project command in `conda run -n <env>`. That is our default internally, and the optional section at the end expands on it. This machine had already been initialized, and `python` resolving to base is something we use all day. Ripping that out means retraining habits, so here we chose to keep it and make it cheap.

The fix is to lazy-load the hook. The idea is that after base is activated, what the shell has gained is a fixed set of environment variables and a PATH prefix. Those can be written down statically. Nothing needs Python to compute them each time. The conda shell functions are only needed the first time someone types `conda`, and that is when the real hook gets loaded.

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

Where do these values come from? Ask conda.

```sh
CONDA_SHLVL=0 conda shell.zsh activate base
```

It prints every `export` that activating base would run. Copy them. Adjust the path to wherever miniconda lives on your machine.

The `CONDA_SHLVL=1` line does extra work. The real hook ends with a check that only activates base when `CONDA_SHLVL` is unset. Because we preset it to 1, the first `conda` call loads the real hook, which sees that base is already active and skips re-activating it. From then on, `conda activate <other>` and `conda deactivate` go through the real hook's functions and behave exactly as before.

To verify, open a clean shell and confirm three things in order. `which python` points at base. `conda --version` triggers the load. After `conda activate <env>` and `conda deactivate`, PATH and `CONDA_SHLVL` change the way they should. All three passed here.

One trap to flag ahead of time. If `conda init zsh` is ever run again, it appends a fresh copy of the original hook to the end of `.zshrc`. Delete the block it appended and keep this one.

## compinit ran twice

Back to the zprof table. `compinit` and `compaudit` both show 2 calls.

`compinit` initializes zsh's completion system. It walks every directory in `fpath`, collects the completion definitions whose names start with `_`, and writes a cache file, `.zcompdump`. `compaudit` is the security check it runs along the way, looking for directories writable by other users. Together they cost 27 ms. Running once is necessary. Running twice is waste.

Where did the second run come from? Reading through `.zshrc` turned it up.

```sh
# >>> grok installer >>>
export PATH="$HOME/.grok/bin:$PATH"
fpath=(~/.grok/completions/zsh $fpath)
autoload -Uz compinit && compinit -C
# <<< grok installer <<<
```

A CLI tool's installer, to make its own completions work, appended an `fpath` entry and a `compinit -C` to the end of `.zshrc`. The problem is the position. oh-my-zsh had already run `compinit` further up, this block ran it again further down, and the second run used the default dump file at `~/.zcompdump`, which is a different file from the hostname-suffixed one oh-my-zsh uses.

The installer is not wrong to write this. It cannot know whether the user runs oh-my-zsh. The fix belongs on our side.

Move the `fpath` line above `source $ZSH/oh-my-zsh.sh` and delete the `compinit` line.

```sh
plugins=(git)

fpath=(~/.grok/completions/zsh $fpath)

source $ZSH/oh-my-zsh.sh
```

Recent oh-my-zsh records a fingerprint of `fpath` inside the dump file and regenerates it when `fpath` changes. So the first shell after this edit is slow once, 0.47 s in our case, and every shell after that is 0.07 s.

While there, we removed three stale `.zcompdump` files. Two were historical, one written under an old hostname and one temporary file left by an interrupted run. The third was the one the redundant `compinit` had been writing. oh-my-zsh names its dump `~/.zcompdump-<hostname>-<zsh version>`. Keep that one and its compiled `.zwc` and nothing else.

## The powerlevel10k layer

powerlevel10k's config file is a little over 1,700 lines, almost all of it generated by `p10k configure`. We had assumed the fifty-odd segments on the right side of the prompt would slow down every Enter. Measuring showed otherwise.

Three settings at the bottom of the file bear directly on speed.

`POWERLEVEL9K_INSTANT_PROMPT=verbose`. On. At the very top of `.zshrc` it paints the prompt cached from the previous session, so the cursor appears immediately while initialization continues underneath. This is why powerlevel10k insists that its instant prompt block sit at the very start of `.zshrc`. It improves perception only. A command typed before `.zshrc` finishes still waits. conda's 230 ms was still in the way.

`POWERLEVEL9K_DISABLE_HOT_RELOAD=true`. On. With hot reload off, powerlevel10k does not check whether the config file changed before every prompt. Config edits need a new terminal or an `exec zsh` to take effect. In exchange, every Enter skips a file check.

`POWERLEVEL9K_VCS_DISABLED_WORKDIR_PATTERN='~'`. This turns the git segment off in the home directory itself, with subdirectories unaffected. Some people make their entire home directory a git repository to manage dotfiles. That repository is large and its status is rarely interesting, so computing it there is pure waste.

Git status itself is computed by a background process called `gitstatusd`, which powerlevel10k downloads into `~/.cache/gitstatus/` on first run. It is asynchronous. The prompt is drawn first and git information is filled in when ready, so no repository size blocks Enter.

As for the fifty-odd segments, `asdf`, `nvm`, `pyenv`, `kubectl`, `aws` and the rest are simply not installed on this machine. powerlevel10k checks once at init whether each command exists, and segments for absent tools drop out of the loop. Leaving them in the list costs nothing.

To measure, in a real terminal, call `_p9k_precmd` twenty times in a row and read zprof.

```sh
zmodload zsh/zprof; zprof -c
for i in {1..20}; do _p9k_precmd; done
zprof | head
```

Inside a git repository, each prompt render came to about 4 ms. Nothing to change.

There is a trap here that we walked into ourselves. The first time, to save effort, we ran the snippet above through `zsh -i -c '...'`. `VCS_INFO_get_data_git` came out at 130 ms per prompt, which looked like the git segment was badly slow. The actual cause was that `zsh -i -c` allocates no terminal, `gitstatusd` fails to start, and powerlevel10k falls back to zsh's built-in synchronous `vcs_info` backend, which forks several `git` processes per prompt. Wrapping the same test in a pseudo-terminal with `script -q /dev/null zsh -i -c '...'` brought the number back to 4 ms. Measure prompt performance only where there is a tty.

## Two small leftovers

A line reading `PYTORCH_ENABLE_MPS_FALLBACK=1` with no `export`. Written that way in `.zshrc`, it sets a shell variable that PyTorch in a child process never sees. It might as well not be there. We added `export`. Unrelated to speed, fixed in passing.

A line reading `export TOKEN="$(cat ~/.some/token-file)"` can be `$(<~/.some/token-file)`. The former forks a `cat`, the latter has zsh read the file itself. The saving is under a millisecond, but there is no upside to the longer form in `.zshrc`, so we change it on sight.

## Keeping it from happening again

Both causes of the slowdown came from installers appending code to the end of `.zshrc`. Neither was wrong on its own. Stacked, they were. The only real defense is to run `zprof` every so often and look at who is on the first line.

There is no standard for how fast a `.zshrc` should be. Ours is 0.07 s after the changes, of which oh-my-zsh loading libs and plugins is 20 ms, `compinit` is 15 ms, and powerlevel10k init is a little over ten. Going lower means replacing oh-my-zsh, and we do not think that is worth it.

## Optional: installing miniconda, and how we use it

This section is for anyone who will run Python projects. The conda section above is about rescuing a machine that has already been through `conda init`. This one is about the setup we recommend on a fresh machine. Pick one or the other.

```sh
brew install --cask miniconda
```

After this, conda is at `/opt/homebrew/Caskroom/miniconda/base/bin/conda`, Homebrew links it into `/opt/homebrew/bin`, and it works as is. Do not run `conda init zsh`.

We chose miniconda over Homebrew's Python for two reasons. It gives every project its own environment with its own Python version, touching neither the system Python nor Homebrew's. And switching between environments can bypass the shell entirely, which is the precondition for not running `conda init`.

Our internal Python projects all follow this pattern.

```sh
# One environment per project; the Python version is pinned here
conda create -n <env_name> python=3.12

# Install uv into the environment first; package management goes through it from then on
conda run -n <env_name> pip install uv

# Libraries
conda run -n <env_name> uv pip install python-dotenv playwright

# Tools that ship a CLI go through uv tool, so the command is available globally
uv tool install crewai

# Run the project
conda run -n <env_name> python main.py
```

There are only four rules.

- Nothing runs in the global Python. Every project has its own environment.
- Packages are installed with `uv pip`, CLI tools with `uv tool`. uv's parallel downloads and hardlinks make setting up an environment a matter of seconds, where pip takes minutes.
- No `conda init`, no `conda activate`. Everything inside an environment is written as `conda run -n <env_name> <command>`. The reason is the first half of this post. Once conda is in `.zshrc`, every shell pays for it, and stacking several Python paths on PATH is how commands get intercepted unexpectedly.
- Secrets and RPC URLs live in the project's `.env`, listed in `.gitignore`. Never in `.zshrc`, never in code.

One behavior of `conda run` worth knowing. By default it buffers the child process's output, so a long-running task may show nothing until it finishes. Add `--no-capture-output` to get live output back.

---

*Prompted by Henry Lin, written by Fable 5.1.*
