import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { platform } from 'node:process';
import type { Language } from '../core/language.ts';
import type { PathPicker, PathPickerOptions } from './shared/path-picker.ts';
import { serverText } from './strings.ts';

type Text = ReturnType<typeof serverText>;

interface ExecFailure extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
}

export class PathPickerRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPickerRequestError';
  }
}

export class PathPickerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathPickerUnavailableError';
  }
}

function stringOption(value: unknown, name: string, t: Text): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new PathPickerRequestError(t.notString(name));
  if (value.includes('\0')) throw new PathPickerRequestError(t.pickerNul(name));
  return value;
}

function normalizeExtension(value: string, t: Text): string {
  const extension = value.trim().toLowerCase();
  if (!/^\.?[a-z0-9][a-z0-9._+-]*$/i.test(extension)) {
    throw new PathPickerRequestError(t.pickerBadExtension(value));
  }
  return extension.startsWith('.') ? extension : `.${extension}`;
}

/** 平台命令只接收经过校验的 JSON 边界值。 */
export function parsePathPickerOptions(raw: unknown, language: Language): PathPickerOptions {
  const t = serverText(language);
  if (!raw || typeof raw !== 'object') throw new PathPickerRequestError(t.pickerBodyNotObject);
  const body = raw as Record<string, unknown>;
  if (body.kind !== 'file' && body.kind !== 'directory') {
    throw new PathPickerRequestError(t.pickerBadKind);
  }
  if (body.extensions != null && !Array.isArray(body.extensions)) {
    throw new PathPickerRequestError(t.pickerBadExtensions);
  }
  const extensions = body.extensions === undefined
    ? undefined
    : [...new Set((body.extensions as unknown[]).map((item) => {
        if (typeof item !== 'string') throw new PathPickerRequestError(t.pickerBadExtensions);
        return normalizeExtension(item, t);
      }))];
  const title = stringOption(body.title, 'title', t);
  const currentPath = stringOption(body.currentPath, 'currentPath', t);
  const recommendedDir = stringOption(body.recommendedDir, 'recommendedDir', t);
  return {
    kind: body.kind,
    ...(title ? { title } : {}),
    ...(currentPath ? { currentPath } : {}),
    ...(recommendedDir ? { recommendedDir } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

/** 浏览器只会收到存在、类型匹配的绝对路径。 */
export async function validatePickedPath(
  selected: string | null,
  options: PathPickerOptions,
  language: Language,
): Promise<string | null> {
  if (selected == null || selected.trim() === '') return null;
  const t = serverText(language);
  const path = isAbsolute(selected) ? resolve(selected) : resolve(process.cwd(), selected);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new PathPickerRequestError(t.pickerMissing(path));
  }
  if (options.kind === 'file' && !info.isFile()) {
    throw new PathPickerRequestError(t.pickerNotFile(path));
  }
  if (options.kind === 'directory' && !info.isDirectory()) {
    throw new PathPickerRequestError(t.pickerNotDirectory(path));
  }
  if (options.kind === 'file' && options.extensions?.length) {
    const lower = path.toLowerCase();
    if (!options.extensions.some((extension) => lower.endsWith(extension.toLowerCase()))) {
      throw new PathPickerRequestError(t.pickerWrongType(options.extensions));
    }
  }
  return path;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(command, args, {
      encoding: 'utf8',
      env: env ? { ...process.env, ...env } : process.env,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolveOutput(stdout);
        return;
      }
      const failure = error as ExecFailure;
      failure.stdout = stdout;
      failure.stderr = stderr;
      reject(failure);
    });
  });
}

function commandMissing(error: unknown): boolean {
  return (error as ExecFailure | null)?.code === 'ENOENT';
}

function cancelled(error: unknown): boolean {
  const failure = error as ExecFailure | null;
  if (failure?.code === 1 && !failure.stderr?.trim()) return true;
  return failure?.code === 1 && /user canceled|-128/i.test(failure.stderr ?? '');
}

async function initialDirectory(options: PathPickerOptions): Promise<string> {
  const requested = options.currentPath?.trim() || options.recommendedDir?.trim();
  if (!requested) return '';
  let candidate = resolve(requested);
  for (;;) {
    try {
      const info = await stat(candidate);
      return info.isDirectory() ? candidate : dirname(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return '';
      candidate = parent;
    }
  }
}

function patterns(options: PathPickerOptions): string[] {
  return (options.extensions ?? []).map((extension) => `*${extension}`);
}

function titleOf(options: PathPickerOptions, t: Text): string {
  return options.title ?? (options.kind === 'file' ? t.pickerTitleFile : t.pickerTitleDirectory);
}

const WINDOWS_SCRIPT = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$title = $env:CORTICO_PICKER_TITLE
$initial = $env:CORTICO_PICKER_INITIAL
if ($env:CORTICO_PICKER_KIND -eq 'directory') {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = $title
  $dialog.ShowNewFolderButton = $true
  if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }
} else {
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = $title
  $dialog.CheckFileExists = $true
  $dialog.Multiselect = $false
  if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.InitialDirectory = $initial }
  $patterns = $env:CORTICO_PICKER_PATTERNS
  $supported = $env:CORTICO_PICKER_SUPPORTED
  $all = $env:CORTICO_PICKER_ALL
  if ($patterns) { $dialog.Filter = "$supported|$patterns|$all|*.*" }
}
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  if ($env:CORTICO_PICKER_KIND -eq 'directory') {
    [Console]::Out.Write($dialog.SelectedPath)
  } else {
    [Console]::Out.Write($dialog.FileName)
  }
}
$dialog.Dispose()
`;

async function pickWindows(options: PathPickerOptions, initial: string, t: Text): Promise<string | null> {
  try {
    const stdout = await run('powershell.exe', [
      '-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT,
    ], {
      CORTICO_PICKER_KIND: options.kind,
      CORTICO_PICKER_TITLE: titleOf(options, t),
      CORTICO_PICKER_INITIAL: initial,
      CORTICO_PICKER_PATTERNS: patterns(options).join(';'),
      CORTICO_PICKER_SUPPORTED: t.pickerSupportedFiles,
      CORTICO_PICKER_ALL: t.pickerAllFiles,
    });
    return stdout.trim() || null;
  } catch (error) {
    throw new PathPickerUnavailableError(commandMissing(error)
      ? t.pickerNoPowerShell
      : t.pickerFailed(String((error as Error).message ?? error)));
  }
}

const MACOS_SCRIPT = String.raw`
on run argv
  set pickerKind to item 1 of argv
  set dialogTitle to item 2 of argv
  set initialPath to item 3 of argv
  set extensionText to item 4 of argv
  set AppleScript's text item delimiters to ","
  set fileTypes to text items of extensionText
  set AppleScript's text item delimiters to ""
  if pickerKind is "directory" then
    if initialPath is "" then
      set picked to choose folder with prompt dialogTitle
    else
      set picked to choose folder with prompt dialogTitle default location (POSIX file initialPath)
    end if
  else if extensionText is "" then
    if initialPath is "" then
      set picked to choose file with prompt dialogTitle
    else
      set picked to choose file with prompt dialogTitle default location (POSIX file initialPath)
    end if
  else
    if initialPath is "" then
      set picked to choose file with prompt dialogTitle of type fileTypes
    else
      set picked to choose file with prompt dialogTitle of type fileTypes default location (POSIX file initialPath)
    end if
  end if
  return POSIX path of picked
end run
`;

async function pickMacos(options: PathPickerOptions, initial: string, t: Text): Promise<string | null> {
  try {
    const extensions = (options.extensions ?? []).map((extension) => extension.slice(1)).join(',');
    const stdout = await run('osascript', [
      '-e', MACOS_SCRIPT, '--', options.kind,
      titleOf(options, t),
      initial,
      extensions,
    ]);
    return stdout.trim() || null;
  } catch (error) {
    if (cancelled(error)) return null;
    throw new PathPickerUnavailableError(commandMissing(error)
      ? t.pickerNoOsascript
      : t.pickerFailed(String((error as Error).message ?? error)));
  }
}

async function pickZenity(options: PathPickerOptions, initial: string, t: Text): Promise<string | null> {
  const args = ['--file-selection', `--title=${titleOf(options, t)}`];
  if (options.kind === 'directory') args.push('--directory');
  if (initial) args.push(`--filename=${initial}${sep}`);
  const filter = patterns(options);
  if (filter.length) args.push(`--file-filter=${t.pickerSupportedFiles} | ${filter.join(' ')}`);
  const stdout = await run('zenity', args);
  return stdout.trim() || null;
}

async function pickKdialog(options: PathPickerOptions, initial: string, t: Text): Promise<string | null> {
  const title = titleOf(options, t);
  const filter = patterns(options);
  const args = options.kind === 'directory'
    ? ['--getexistingdirectory', initial || resolve('.'), '--title', title]
    : [
        '--getopenfilename', initial || resolve('.'),
        filter.length ? `${filter.join(' ')}|${t.pickerSupportedFiles}` : `*|${t.pickerAllFiles}`,
        '--title', title,
      ];
  const stdout = await run('kdialog', args);
  return stdout.trim() || null;
}

async function pickLinux(options: PathPickerOptions, initial: string, t: Text): Promise<string | null> {
  let zenityError: unknown;
  try {
    return await pickZenity(options, initial, t);
  } catch (error) {
    if (cancelled(error)) return null;
    zenityError = error;
  }
  try {
    return await pickKdialog(options, initial, t);
  } catch (error) {
    if (cancelled(error)) return null;
    const commandsMissing = commandMissing(zenityError) && commandMissing(error);
    throw new PathPickerUnavailableError(commandsMissing
      ? t.pickerNoLinuxTool
      : t.pickerFailed(String((error as Error).message ?? error)));
  }
}

export async function pickNativePath(options: PathPickerOptions, language: Language): Promise<string | null> {
  const t = serverText(language);
  const initial = await initialDirectory(options);
  if (platform === 'win32') return pickWindows(options, initial, t);
  if (platform === 'darwin') return pickMacos(options, initial, t);
  if (platform === 'linux') return pickLinux(options, initial, t);
  throw new PathPickerUnavailableError(t.pickerUnsupported(platform));
}

export const nativePathPicker: PathPicker = { pick: pickNativePath };
