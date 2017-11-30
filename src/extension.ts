/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { spawn, exec } from 'child_process';
import { basename } from 'path';
import * as nls from 'vscode-nls';
import { listProcesses, ProcessItem } from './ps';
import { TreeDataProvider, TreeItem, EventEmitter, Event, ProviderResult } from 'vscode';
import { setInterval, clearInterval } from 'timers';
import * as paths from 'path';
import * as os from 'os';

export const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=([0-9]+))?/;

export function activate(context: vscode.ExtensionContext) {

	vscode.window.registerTreeDataProvider('extension.vscode-processes.processViewer', new ProcessProvider(context));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebug', (item: ProcessTreeItem) => {

		const config: vscode.DebugConfiguration = {
			type: 'node',
			request: 'attach',
			name: 'attach to process'
		};

		const matches = DEBUG_FLAGS_PATTERN.exec(item._process.cmd);
		if (matches && matches.length >= 2) {
			if (matches.length === 5 && matches[4]) {
				config.port = parseInt(matches[4]);
			}
			config.protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
		} else {	// no port -> try to attach via SIGUSR and pid
			config.processId = String(item._process.pid);
		}
		vscode.debug.startDebugging(undefined, config);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startProfiling', async (item: ProcessTreeItem) => {
		const profiler = await import('v8-inspect-profiler');
		const matches = DEBUG_FLAGS_PATTERN.exec(item._process.cmd);
		var port;
		if (matches && matches.length >= 2) {
			let port = 9229;
			if (matches.length === 5 && matches[4]) {
				port = parseInt(matches[4]);
			}
			
			const commandId = `cpu-profile-${port}`;
			return profiler.startProfiling({ port: port }).then(session => {				
				let updater;
				let timeStarted = new Date().getTime();
				var statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
				statusBarItem.text = `$(primitive-dot) Profiling ${item._process.name}`;
				statusBarItem.tooltip = 'Click to stop';
				
				const disposeStatusBarItem = () => {
					commandDisposable.dispose();
					clearInterval(updater);
					statusBarItem.hide();
					statusBarItem.dispose();
				};
				
				const commandDisposable = vscode.commands.registerCommand(commandId, () => {
					return vscode.window.showQuickPick(['Upload', 'Save', 'Discard']).then(val => {
						item._process.profiling = false;
						item._eventEmitter.fire(item);
						if (val === 'Discard') {
							disposeStatusBarItem();
							return session.stop();
						} else if (val === 'Upload') {
							return session.stop().then(profile => {
								const filenamePrefix = paths.join(vscode.env['globalLoggingDirectory'], Math.random().toString(16).slice(-4));
								const fileName = `${filenamePrefix}.cpuprofile`;
								return profiler.writeProfile(profile, fileName).then(() => {
									vscode.commands.executeCommand('verbose-logging.previewOrUpload');
									disposeStatusBarItem();
								}, disposeStatusBarItem);
							});
						} else {
							return session.stop().then(profile => {
								item._process.profiling = false;
								item._eventEmitter.fire(item);
								vscode.window.showSaveDialog({}).then(uri => {
									const filePath = uri.path;
									return profiler.writeProfile(profile, uri.path).then(() => {
										vscode.window.showInformationMessage(`CPU Profile saved to ${filePath}`);
										disposeStatusBarItem();
									}, disposeStatusBarItem)
								});
							});
						}
					});
				});
		
				statusBarItem.command = commandId;
				statusBarItem.show();
				
				updater = setInterval(() => {
					let label = `$(primitive-dot) Profiling ${item._process.name}`;
					if (timeStarted > 0) {
						let secondsRecoreded = (new Date().getTime() - timeStarted) / 1000;
						label = ` $(primitive-dot) Profiling ${item._process.name} (${Math.round(secondsRecoreded)} sec)`;
					}
					
					statusBarItem.text = label;
				}, 1000);
				
				item._process.profiling = true;
				// item.iconPath = context.asAbsolutePath('images/breakpoint.svg');
				item._eventEmitter.fire(item);
			});
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.kill', (item: ProcessTreeItem) => {
		if (item._process.pid) {
			process.kill(item._process.pid, 'SIGTERM');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.forceKill', (item: ProcessTreeItem) => {
		if (item._process.pid) {
			process.kill(item._process.pid, 'SIGKILL');
		}
	}));
}

// this method is called when your extension is deactivated
export function deactivate() {
}

function getName(process: ProcessItem): string {
	return process['deleted'] ? process.name : `${process.name} (${process.load}, ${process.mem})`;
}

function getState(process: ProcessItem): vscode.TreeItemCollapsibleState {
	return process.children && process.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
}

class ProcessTreeItem extends TreeItem {
	_process: ProcessItem;
	_context: vscode.ExtensionContext;
	_eventEmitter: EventEmitter<ProcessTreeItem>;
	
	constructor(process: ProcessItem, context: vscode.ExtensionContext, eventEmitter: EventEmitter<ProcessTreeItem>) {
		super(getName(process), getState(process));
		this._process = process;
		this._context = context;
		this._eventEmitter = eventEmitter;

		const matches = DEBUG_FLAGS_PATTERN.exec(process.cmd);
		if ((matches && matches.length >= 2)) {
			if (process.name.startsWith('node')) {
				this.contextValue = 'node';
				
				if (matches[1] === 'debug') {
					this.contextValue = 'node_inspect';
				}
			} else if (process.electronProcess && matches[1] === 'inspect') {
				this.contextValue = 'electron_inspect';
				
				if (process.profiling) {
					this.iconPath = this._context.asAbsolutePath('images/breakpoint.svg');
				} else {
					this.iconPath = this._context.asAbsolutePath('images/breakpoint-disabled-dark.svg');
				}
			}
		}	
	}
	getChildren(): ProcessTreeItem[] {
		if (this._process.children) {
			return this._process.children.map(child => new ProcessTreeItem(child, this._context, this._eventEmitter));
		}
		return [];
	}
}

export class ProcessProvider implements TreeDataProvider<ProcessTreeItem> {

	private static KEEP_TERMINATED = false;

	private _root: ProcessTreeItem;

	private _onDidChangeTreeData: EventEmitter<ProcessTreeItem> = new EventEmitter<ProcessTreeItem>();
	readonly onDidChangeTreeData: Event<ProcessTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {

		const pid = parseInt(process.env['VSCODE_PID']);

		this._root = new ProcessTreeItem({ name: 'root', pid: 0, ppid: 0, cmd: 'root', load: 0.0, mem: 0.0 }, context, this._onDidChangeTreeData);

		setInterval(_ => {
			listProcesses(pid).then(process => {
				const changed = this.merge(this._root._process, process);
				this._onDidChangeTreeData.fire(undefined);
			});
		}, 1000);
	}

	private merge(old: ProcessItem, process: ProcessItem) {

		old.cmd = process.cmd;
		old.load = process.load;
		old.mem = process.mem;

		old.children = old.children || [];
		process.children = process.children || [];

		const result: ProcessItem[] = [];
		for (const child of process.children) {
			const found = old.children.find(c => child.pid === c.pid);
			if (found) {
				this.merge(found, child);
				result.push(found);
			} else {
				result.push(child);
			}
		}

		if (ProcessProvider.KEEP_TERMINATED) {
			for (const child of old.children) {
				const found = process.children.find(c => child.pid === c.pid);
				if (!found) {
					child['deleted'] = true;
					result.push(child);
				}
			}
		}

		old.children = result.sort((a, b) => a.pid - b.pid);
	}

	getTreeItem(element: ProcessTreeItem): ProcessTreeItem | Thenable<ProcessTreeItem> {
		return element;
	}

	getChildren(element?: ProcessTreeItem): vscode.ProviderResult<ProcessTreeItem[]> {
		return (element || this._root).getChildren();
	}
}