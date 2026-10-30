// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { undo, redo } from '@codemirror/commands';
import { createPrefixEditor } from '../../src/web/client/features/prompts/editor.ts';

type Any = any;
/** 查询结果按 Any 用:测试里节点必在,缺了就让断言或调用直接失败。 */
const $ = (sel: string, from: ParentNode = document): Any => from.querySelector(sel);
const $$ = (sel: string, from: ParentNode = document): Any[] => [...from.querySelectorAll(sel)];

const mounted: Any[] = [];
function mount(blocks: Any) {
  const changes = new Map();
  const parent = document.createElement('div');
  document.body.append(parent);
  const editor = createPrefixEditor({
    parent, onChange: (batch: Any) => { for (const c of batch) changes.set(c.sourceKey, c.text); },
    onSave() {}, onGeometry() {}, onFold() {},
  });
  mounted.push(editor);
  editor.setBlocks(blocks.map((block: Any) => ({ ...block, description: 'Section explanation' })));
  return { editor, changes };
}
afterEach(() => { for (const editor of mounted.splice(0)) editor.dispose(); document.body.replaceChildren(); });

describe('continuous prompt document', () => {
  it('folds presentation without changing template text, including CRLF and empty sources', () => {
    const { editor, changes } = mount([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity\r\nVoice\r\n' },
      { title: 'ENVIRONMENT', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: '' },
    ]);
    expect(editor.blockGeometry().map((g: Any) => g.collapsed)).toEqual([false, true]);
    const before = editor.view.state.doc.toString();
    $('.prefix-comment[data-block="0"] button', editor.view.dom).click();
    $('.prefix-comment[data-block="1"] button', editor.view.dom).click();
    expect(editor.blockGeometry().map((g: Any) => g.collapsed)).toEqual([true, false]);
    expect(editor.canUndo()).toBe(false);
    expect(editor.view.state.doc.toString()).toBe(before);
    expect(editor.text('constitution')).toBe('Identity\nVoice\n');
    expect(changes.size).toBe(0);
    editor.view.dispatch({ changes: { from: before.length, insert: 'Environment' } });
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Environment');
    expect(editor.text('constitution')).toBe('Identity\nVoice\n');
  });

  it('keeps edits inside their source and rejects deletion through generated text or separators', () => {
    const { editor } = mount([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Persona' },
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
    ]);
    editor.setCollapsed(1, false);
    editor.view.dispatch({ changes: { from: 7, insert: '!' } });
    expect(editor.text('constitution')).toBe('Persona!');
    const before = editor.view.state.doc.toString();
    editor.view.dispatch({ changes: { from: 8, to: 10 } });
    editor.view.dispatch({ changes: { from: 11, insert: 'no' } });
    expect(editor.view.state.doc.toString()).toBe(before);
    editor.setBlocks([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Persona!', description: '' },
      { title: 'WORKSPACE', tone: 'derived', text: 'new.md', description: '' },
    ]);
    expect(editor.text('constitution')).toBe('Persona!');
    expect(editor.view.state.doc.toString()).toBe('Persona!\nnew.md');
  });

  it('keeps generated refreshes out of source undo and redo history', () => {
    const { editor } = mount([
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
    ]);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '!' }, userEvent: 'input.type' });
    editor.setBlocks([
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md\nnotes.md', description: '' },
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity!', description: '' },
    ]);
    editor.undo();
    expect(editor.view.state.doc.toString()).toBe('files.md\nnotes.md\nIdentity');
    expect(editor.canUndo()).toBe(false);
    editor.redo();
    expect(editor.view.state.doc.toString()).toBe('files.md\nnotes.md\nIdentity!');
  });

  it('inserts a reference token, removes it as a whole and undoes while its section is folded', () => {
    const key = 'constitution';
    const { editor } = mount([{ title: 'CONSTITUTION', sourceKey: key, tone: 'persona', text: 'Hello ', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] }]);
    editor.insert(key, 'fixture.name', 6);
    expect(editor.text(key)).toBe('Hello {{fixture.name}}');
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('fixture.name');
    ($('.prompt-reference-remove', editor.view.dom)).click();
    expect(editor.text(key)).toBe('Hello ');
    editor.setCollapsed(0, true);
    undo(editor.view);
    expect(editor.text(key)).toBe('Hello {{fixture.name}}');
    redo(editor.view);
    expect(editor.text(key)).toBe('Hello ');
  });

  it('previews current values and fallbacks in place without changing unsaved template text or undo history', () => {
    const { editor, changes } = mount([{ title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'For {{ fixture.name | Friend }}', vars: [{ name: 'fixture.name', description: 'Name', value: '' }] }]);
    editor.view.dispatch({ changes: { from: 0, insert: 'Hello! ' }, userEvent: 'input' });
    changes.clear();
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('fixture.name');
    editor.setPreview('constitution', true);
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('Friend');
    editor.updateVariables('constitution', [{ name: 'fixture.name', description: 'Name', value: 'Partner' }]);
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('Partner');
    editor.updateVariables('constitution', [{ name: 'fixture.name', description: 'Name' }]);
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('{{ fixture.name | Friend }}');
    editor.setPreview('constitution', false);
    expect($('.prompt-reference-label', editor.view.dom)?.textContent).toBe('fixture.name');
    expect(editor.text('constitution')).toBe('Hello! For {{ fixture.name | Friend }}');
    expect(changes.size).toBe(0);
    undo(editor.view);
    expect(editor.text('constitution')).toBe('For {{ fixture.name | Friend }}');
  });

  it('keeps undo at the reference that was edited instead of a stale caret in another section', () => {
    const { editor } = mount([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: 'Hello {{fixture.name}}!', vars: [{ name: 'fixture.name', description: 'Name', value: 'Friend' }] },
    ]);
    editor.setCollapsed(1, false);
    const position = editor.view.state.doc.toString().indexOf('{{');
    ($('.prompt-reference-remove', editor.view.dom)).click();
    editor.undo();
    expect(editor.view.state.selection.main.head).toBe(position);
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Hello {{fixture.name}}!');
    editor.view.dispatch({ selection: { anchor: 0 } });
    editor.insert('worlds.fixture.envPrompt', 'fixture.name', position);
    editor.undo();
    expect(editor.view.state.selection.main.head).toBe(position);
    editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', code: 'KeyZ', keyCode: 90, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    expect(editor.text('worlds.fixture.envPrompt')).toBe('Hello {{fixture.name}}{{fixture.name}}!');
  });

  it('previews only the selected section and recognizes manually typed references followed by space', () => {
    const vars = [{ name: 'fixture.name', description: 'Name', value: 'Friend' }];
    const { editor } = mount([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: '{{fixture.name}}', vars },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: '', vars },
    ]);
    editor.setCollapsed(1, false);
    for (const char of '{{fixture.name}} ') {
      editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: char }, userEvent: 'input.type' });
    }
    expect(editor.text('worlds.fixture.envPrompt')).toBe('{{fixture.name}} ');
    editor.setPreview('worlds.fixture.envPrompt', true);
    expect($$('.prompt-reference-label', editor.view.dom).map((el: Any) => el.textContent)).toEqual(['fixture.name', 'Friend']);
    editor.setPreview('worlds.fixture.envPrompt', false);
    expect($$('.prompt-reference-label', editor.view.dom).map((el: Any) => el.textContent)).toEqual(['fixture.name', 'fixture.name']);
  });

  it('restores saved sources including folded sections as one undoable edit, retaining generated text', () => {
    const { editor, changes } = mount([
      { title: 'CONSTITUTION', sourceKey: 'constitution', tone: 'persona', text: 'Identity' },
      { title: 'WORKSPACE', tone: 'derived', text: 'files.md' },
      { title: 'WORLD', sourceKey: 'worlds.fixture.envPrompt', tone: 'world', text: 'Environment' },
    ]);
    editor.view.dispatch({ changes: { from: 0, insert: 'New ' } });
    editor.setCollapsed(2, false);
    editor.view.dispatch({ changes: { from: editor.view.state.doc.length, insert: '!' } });
    editor.setCollapsed(2, true);
    const edited = editor.view.state.doc.toString();
    editor.restore(new Map([['constitution', 'Identity'], ['worlds.fixture.envPrompt', 'Environment']]));
    expect(editor.view.state.doc.toString()).toBe('Identity\nfiles.md\nEnvironment');
    expect(changes.get('constitution')).toBe('Identity');
    expect(changes.get('worlds.fixture.envPrompt')).toBe('Environment');
    expect(editor.blockGeometry()[2].collapsed).toBe(true);
    editor.undo();
    expect(editor.view.state.doc.toString()).toBe(edited);
  });
});
