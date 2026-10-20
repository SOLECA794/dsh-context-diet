(async()=>{
const {routeText, detectKind, extractExitCode} = await import('./lib/fold.js');

// 1) Rust build log with errors
const buildLines = [];
for (let i=0;i<400;i++) buildLines.push(`   Compiling klib v0.1.0 (/mnt/d/kernel-project/src/klib)`);
buildLines.push('error[E0308]: mismatched types');
buildLines.push('  --> src/kernel/mm/memory_set.rs:131:24');
buildLines.push('   |');
buildLines.push('131|         self.map_into(page_table)');
buildLines.push('   |              ^^^^^^^^^^^^^^^^^^ expected `()`, found `Result<(), MemoryError>`');
buildLines.push('');
buildLines.push('warning: unused variable: `step_3`');
buildLines.push('   --> src/kernel/mm/memory_set.rs:145:13');
buildLines.push('    |');
buildLines.push('145 |         let step_3 = 3;');
buildLines.push('    |             ^^^^^^ help: if this is intentional, prefix it with an underscore');
for (let i=0;i<50;i++) buildLines.push(`   Finished dev [unoptimized + debuginfo] target(s) in ${i}.0s`);
const build = buildLines.join('\n');
const r1 = routeText(build, {toolName:'pwsh'});
console.log('BUILD: kind', detectKind(build), 'reducer', r1.reducer, r1.originalChars, '->', r1.compressedChars, 'saved', (100*(1-r1.compressedChars/r1.originalChars)).toFixed(1)+'%', 'exit', extractExitCode(build));
console.log(r1.text.split('\n').slice(0,14).map(l=>'  | '+l).join('\n'));

// 2) grep output
const grep = [];
for (let f=0;f<12;f++) for (let i=0;i<40;i++) grep.push(`src/kernel/task/mod${f}.rs:${i+10}:    fn schedule_${i}() { todo!() }`);
const gtext = grep.join('\n');
const r2 = routeText(gtext, {toolName:'grep'});
console.log('\nGREP: reducer', r2.reducer, r2.originalChars, '->', r2.compressedChars, 'saved', (100*(1-r2.compressedChars/r2.originalChars)).toFixed(1)+'%');
console.log(r2.text.split('\n').slice(0,6).map(l=>'  | '+l).join('\n'));

// 3) JSON
const arr = Array.from({length:300}, (_,i)=>({id:i, name:'task_'+i, state:'ready', path:'/src/kernel/mm/'+i+'.rs'}));
const json = JSON.stringify({items:arr, total:300}, null, 2);
const r3 = routeText(json, {toolName:'pwsh'});
console.log('\nJSON: kind', detectKind(json), 'reducer', r3.reducer, r3.originalChars, '->', r3.compressedChars, 'saved', (100*(1-r3.compressedChars/r3.originalChars)).toFixed(1)+'%');
console.log(r3.text.split('\n').slice(0,10).map(l=>'  | '+l).join('\n'));
})().catch(e=>{console.error('ERR',e);process.exit(1)})
