import { BasicList, workspace, Uri, ListAction, ListContext, ListItem, Neovim } from 'coc.nvim'
import Manager from '../manager'
import fs from 'fs'
import path from 'path'
import { runCommand, spawnCommand } from '../util'
import colors from 'colors/safe'

const STATUS_MAP = {
  ' ': ' ',
  M: colors.cyan('~'),
  A: colors.green('+'),
  D: colors.red('-'),
  R: colors.magenta('→'),
  C: colors.yellow('C'),
  U: colors.blue('U'),
  '?': colors.gray('?')
}

export default class GStatus extends BasicList {
  public readonly name = 'gstatus'
  public readonly description = 'Git status of current project'
  public readonly defaultAction = 'open'
  public actions: ListAction[] = []

  constructor(nvim: Neovim, private manager: Manager) {
    super(nvim)
    this.addLocationActions()
    this.addMultipleAction('add', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative)
      await spawnCommand('git', ['add', ...fileArgs], root)
    }, { reload: true, persist: true })

    this.addMultipleAction('patch', async items => {
      let { root } = items[0].data
      let fileArgs = items.map(o => o.data.relative.replace(/\s/, '\\ '))
      let cmd = `git add ${fileArgs.join(' ')} --patch`
      await nvim.call('coc#util#open_terminal', [{
        cmd,
        cwd: root
      }])
    })

    this.addMultipleAction('commit', async items => {
      let { root } = items[0].data
      await nvim.command(`exe "lcd ".fnameescape('${root}')`)
      let filesArg = await nvim.eval(`join(map([${items.map(s => "'" + s.data.relative + "'").join(',')}],'fnameescape(v:val)'),' ')`)
      try {
        await nvim.command(`Gcommit -v ${filesArg}`)
      } catch (e) {
        workspace.showMessage(`Gcommit command failed, make sure fugitive installed.`, 'error')
      }
    })

    this.addAction('reset', async item => {
      let { staged, tree, relative, root } = item.data
      if (staged && tree) {
        let choices = ['&Reset', '&Checkout']
        let n = await nvim.call('confirm', [`Choose action for ${relative}:`, choices.join('\n')]) as number
        if (!n || n < 1) return
        if (n == 1) {
          await this.reset(root, relative)
        } else {
          await this.checkout(root, relative)
        }
      } else if (tree) {
        await this.checkout(root, relative)
      } else if (staged) {
        await this.reset(root, relative)
      } else {
        let confirmed = await workspace.showPrompt(`remove ${relative}?`)
        if (!confirmed) return
        let hasRmtrash = await nvim.call('executable', ['rmtrash'])
        let fullpath = path.join(root, relative)
        if (hasRmtrash) {
          await runCommand(`rmtrash ${fullpath.replace(/\s/, '\\ ')}`)
        } else {
          fs.unlinkSync(fullpath)
        }
      }
    }, { reload: true, persist: true })

    // preview the diff
    this.addAction('preview', async (item, context) => {
      let { tree_symbol, root, relative } = item.data
      if (tree_symbol != 'M') {
        await this.previewLocation({
          uri: Uri.file(path.join(root, relative)).toString(),
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 }
          }
        }, context)
        return
      }
      let args = ['--no-pager', 'diff']
      let winid = context.listWindow.id
      let cmd = `git ${args.join(' ')} ${relative}`
      let content = await runCommand(cmd, { cwd: root })
      let lines = content.trim().split('\n')
      let mod = context.options.position == 'top' ? 'below' : 'above'
      let height = Math.min(this.previewHeight, lines.length)
      await nvim.command('pclose')
      nvim.pauseNotification()
      nvim.command(`${mod} ${height}sp +setl\\ previewwindow [diff]`, true)
      nvim.command('setl winfixheight buftype=nofile nofoldenable', true)
      nvim.command('setl nobuflisted bufhidden=wipe', true)
      nvim.command('setf diff', true)
      nvim.call('append', [0, lines], true)
      nvim.command('normal! Gdd', true)
      nvim.command(`exe 1`, true)
      nvim.call('win_gotoid', [winid], true)
      await nvim.resumeNotification()
    })
  }

  private async reset(root: string, relative: string): Promise<void> {
    await spawnCommand('git', ['reset', 'HEAD', '--', relative], root)
  }

  private async checkout(root: string, relative: string): Promise<void> {
    await spawnCommand('git', ['checkout', '--', relative], root)
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let buf = await context.window.buffer
    let root = await this.manager.resolveGitRoot(buf.id)
    if (!root) {
      throw new Error(`Can't resolve git root.`)
      return
    }
    let output = await runCommand(`git status --porcelain -uall ${context.args.join(' ')}`, { cwd: root })
    output = output.replace(/\s+$/, '')
    if (!output) return []
    // let root = this.manager.refreshStatus
    let res: ListItem[] = []
    for (let line of output.split(/\r?\n/)) {
      let filepath = path.join(root, line.slice(3))
      let index_symbol = STATUS_MAP[line[0]]
      let tree_symbol = STATUS_MAP[line[1]]
      res.push({
        label: `${index_symbol}${tree_symbol} ${line.slice(3)}`,
        filterText: line.slice(3),
        data: {
          root,
          relative: line.slice(3),
          index_symbol: line[0],
          tree_symbol: line[1],
          staged: line[0] != ' ' && line[0] != '?',
          tree: line[1] != ' ' && line[1] != '?',
        },
        location: Uri.file(filepath).toString()
      })
    }
    return res
  }
}
