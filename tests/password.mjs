import assert from 'node:assert/strict';
import {generatePassword,PASSWORD_ALPHABET,PASSWORD_LENGTH} from '../src/password.ts';
assert.equal(new Set(PASSWORD_ALPHABET).size,PASSWORD_ALPHABET.length);
assert.match(PASSWORD_ALPHABET,/^[A-Za-z0-9]+$/);
assert.doesNotMatch(PASSWORD_ALPHABET,/[0Oo1IiLl5Ss2Zz8B]/);
assert.ok(PASSWORD_LENGTH*Math.log2(PASSWORD_ALPHABET.length)>=128);
let calls=0;
const deterministic={getRandomValues(bytes){calls++;bytes.fill(255);if(calls>1)for(let i=0;i<bytes.length;i++)bytes[i]=i%PASSWORD_ALPHABET.length;return bytes;}};
assert.equal(generatePassword(deterministic),PASSWORD_ALPHABET.slice(0,PASSWORD_LENGTH));
assert.equal(calls,2,'Rejected bytes must request fresh entropy');
for(let i=0;i<100;i++){const value=generatePassword();assert.equal(value.length,PASSWORD_LENGTH);assert.ok([...value].every(c=>PASSWORD_ALPHABET.includes(c)));}
assert.throws(()=>generatePassword({getRandomValues(){throw Error('entropy unavailable');}}),/entropy unavailable/);
assert.throws(()=>generatePassword({}),/getRandomValues/,'Missing cryptographic API must fail without a fallback');
console.log(JSON.stringify({status:'PASS',length:PASSWORD_LENGTH,alphabetSize:PASSWORD_ALPHABET.length,theoreticalBits:PASSWORD_LENGTH*Math.log2(PASSWORD_ALPHABET.length),rejectionSampling:true,secretValuesLogged:false}));
