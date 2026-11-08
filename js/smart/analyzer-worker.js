/**
 * Lights Smart — offline music analyzer (Web Worker).
 *
 * Input:  { mid: Float32Array, side: Float32Array, sampleRate }   (already down-mixed / decimated)
 * Output: tempo, beat grid, bar grid, song structure mapped onto the 23 choreography phases
 *         of the original experience, plus 60 fps spectrum (64 bands) and vocal-volume curves
 *         in the same units the original baked data used.
 */

'use strict';

// Original choreography: macro sections, the phases inside each, and their original lengths (s).
var MACROS = [
	{ name: 'B1', label: 'verse',   phases: [ 1, 2 ],             durs: [ 17.5, 15.5 ],      energy: 0.35 },
	{ name: 'C1', label: 'chorus',  phases: [ 3, 4, 5, 6 ],       durs: [ 8, 7.5, 8.5, 8 ],  energy: 0.75 },
	{ name: 'B2', label: 'verse',   phases: [ 7, 8, 9, 10 ],      durs: [ 8, 8, 8, 8 ],      energy: 0.45 },
	{ name: 'C2', label: 'chorus',  phases: [ 11, 12, 13, 14 ],   durs: [ 8, 8, 8, 8 ],      energy: 0.8 },
	{ name: 'D1', label: 'bridge',  phases: [ 15 ],               durs: [ 13.75 ],           energy: 0.55 },
	{ name: 'S',  label: 'drop',    phases: [ 16 ],               durs: [ 2.25 ],            energy: 0.0 },
	{ name: 'C3', label: 'chorus',  phases: [ 17, 18, 19, 20 ],   durs: [ 8, 8, 8, 8 ],      energy: 0.9 },
	{ name: 'D2', label: 'bridge',  phases: [ 21 ],               durs: [ 16 ],              energy: 0.7 },
	{ name: 'A2', label: 'outro',   phases: [ 22 ],               durs: [ 10 ],              energy: 0.25 }
];
var ORIGINAL_SPAN = 203; // 7s (end of intro) -> 210s (END) in the original song

// Choreography fit: energy match per bar, section-length prior, reward for boundaries on novelty peaks
var PLAN_WEIGHTS = { energy: 1, duration: 3, novelty: 2, events: 2.5 };

var NB = 64;             // spectrum bands (matches spectrumData.png)
var FFT_N = 1024;
var HOP = 256;

self.onmessage = function( e ) {

	var d = e.data;

	try {

		var result = analyze( d.mid, d.side, d.sampleRate, function( p, label ) {

			self.postMessage( { type: 'progress', p: p, label: label } );
		} );

		self.postMessage( { type: 'done', result: result }, [ result.spectrum.buffer, result.vox.buffer, result.level.buffer,
			result.kicks.buffer, result.snares.buffer, result.hats.buffer, result.accents.buffer ] );
	}
	catch( err ) {

		self.postMessage( { type: 'error', message: String( err && err.stack || err ) } );
	}
};

// ___________________________________________________________________________________________ Analysis

function analyze( mid, side, sr, progress ) {

	var N = FFT_N, half = N / 2, hop = HOP,
		fps = sr / hop,
		nFrames = Math.floor( mid.length / hop ) + 1,
		duration = mid.length / sr,
		binHz = sr / N,
		win = hann( N ),
		fft = makeFFT( N ),
		re = new Float64Array( N ), im = new Float64Array( N ),
		magM = new Float64Array( half ), magS = new Float64Array( half ),
		logPrev = new Float64Array( half ), logCur = new Float64Array( half ),
		f, i, k, b, tmp;

	// Band layout: 64 log-spaced bands, 40 Hz .. 10 kHz
	var fLo = 40, fHi = Math.min( 10000, sr * 0.48 ),
		bandLo = new Int32Array( NB ), bandHi = new Int32Array( NB ), bandCenter = new Float64Array( NB );

	for( b = 0; b < NB; b++ ) {

		var f0 = fLo * Math.pow( fHi / fLo, b / NB ),
			f1 = fLo * Math.pow( fHi / fLo, ( b + 1 ) / NB );

		bandLo[ b ] = Math.ceil( f0 / binHz );
		bandHi[ b ] = Math.min( half - 1, Math.floor( f1 / binHz ) );
		bandCenter[ b ] = Math.sqrt( f0 * f1 ) / binHz;
	}

	// Pitch class of each bin (chroma), bass / vocal ranges
	var pcOf = new Int8Array( half );

	for( k = 0; k < half; k++ ) {

		var fk = k * binHz;
		pcOf[ k ] = -1;

		if( fk >= 60 && fk <= 5000 )
			pcOf[ k ] = ( ( Math.round( 69 + 12 * Math.log2( fk / 440 ) ) % 12 ) + 12 ) % 12;
	}

	var lowHi = Math.max( 1, Math.floor( 150 / binHz ) ),
		voxLo = Math.round( 250 / binHz ),
		voxHi = Math.min( half - 1, Math.round( 3500 / binHz ) ),
		fluxHi = Math.min( half - 1, Math.round( 8000 / binHz ) ),
		snareLo = Math.round( 1200 / binHz ),
		snareHi = Math.min( half - 1, Math.round( 6000 / binHz ) ),
		hatLo = Math.min( half - 2, Math.round( 6000 / binHz ) );

	// Voice cue: dominant centred pitch per frame (harmonic sum over 1/8-semitone candidates)
	var pitchCands = [], pitchIdx = new Int16Array( nFrames ), pitchSal = new Float32Array( nFrames ),
		centred = new Float64Array( half ), pc;

	for( pc = 0; 110 * Math.pow( 2, pc / 96 ) < 800; pc++ )
		pitchCands.push( 110 * Math.pow( 2, pc / 96 ) / binHz );

	var bands = new Float32Array( nFrames * NB ),
		chroma = new Float32Array( nFrames * 12 ),
		energy = new Float32Array( nFrames ),
		bass = new Float32Array( nFrames ),
		flux = new Float32Array( nFrames ),
		lowFlux = new Float32Array( nFrames ),
		midFlux = new Float32Array( nFrames ),
		hiFlux = new Float32Array( nFrames ),
		voxRaw = new Float32Array( nFrames ),
		vocalRaw = new Float32Array( nFrames );

	for( f = 0; f < nFrames; f++ ) {

		var start = f * hop - half;

		for( i = 0; i < N; i++ ) {

			var idx = start + i;

			if( idx >= 0 && idx < mid.length ) {

				re[ i ] = mid[ idx ] * win[ i ];
				im[ i ] = side[ idx ] * win[ i ];
			}
			else {

				re[ i ] = im[ i ] = 0;
			}
		}

		// One complex FFT gives both real spectra: z = mid + i * side
		fft( re, im );

		for( k = 0; k < half; k++ ) {

			var nk = ( N - k ) & ( N - 1 ),
				a = re[ k ], bb = im[ k ], c = re[ nk ], dd = im[ nk ],
				mr = ( a + c ) * 0.5, mi = ( bb - dd ) * 0.5,
				sr2 = ( bb + dd ) * 0.5, si = ( a - c ) * 0.5;

			magM[ k ] = Math.sqrt( mr * mr + mi * mi );
			magS[ k ] = Math.sqrt( sr2 * sr2 + si * si );
		}

		// Energy, bass, flux
		var e = 0, eb = 0, fl = 0, lfl = 0, mfl = 0, hfl = 0, vx = 0, cv = 0, m2;

		for( k = 1; k < half; k++ ) {

			m2 = magM[ k ] * magM[ k ];
			e += m2;

			if( k <= lowHi )
				eb += m2;

			logCur[ k ] = Math.log( 1 + 10 * magM[ k ] );

			var dl = logCur[ k ] - logPrev[ k ];

			if( dl > 0 ) {

				if( k <= fluxHi )
					fl += dl;

				if( k <= lowHi )
					lfl += dl;
				else if( k >= snareLo && k <= snareHi )
					mfl += dl;

				if( k >= hatLo )
					hfl += dl;
			}

			if( k >= voxLo && k <= voxHi ) {

				var v = m2 - 0.8 * magS[ k ] * magS[ k ];

				if( v > 0 )
					vx += v;

				// Centre-panned sound in the voice range (lead vocals sit in the middle of the mix)
				var cm = magM[ k ] - magS[ k ];

				if( cm > 0 )
					cv += cm * cm;
			}

			if( pcOf[ k ] >= 0 )
				chroma[ f * 12 + pcOf[ k ] ] += m2;
		}

		tmp = logPrev; logPrev = logCur; logCur = tmp;

		energy[ f ] = e;
		bass[ f ] = eb;
		flux[ f ] = f > 0 ? fl : 0;
		lowFlux[ f ] = f > 0 ? lfl : 0;
		midFlux[ f ] = f > 0 ? mfl : 0;
		hiFlux[ f ] = f > 0 ? hfl : 0;
		voxRaw[ f ] = Math.sqrt( vx );
		vocalRaw[ f ] = Math.log( 1e-4 + Math.sqrt( cv ) );

		for( k = 0; k < half; k++ )
			centred[ k ] = Math.max( 0, magM[ k ] - magS[ k ] );

		var bestSal = 0, bestPc = 0;

		for( pc = 0; pc < pitchCands.length; pc++ ) {

			var sal = 0, hw = 1;

			for( var h = 1; h <= 6; h++, hw *= 0.8 ) {

				var kk = pitchCands[ pc ] * h, k0 = Math.floor( kk ), kt = kk - k0;

				if( k0 + 1 >= half )
					break;

				sal += ( centred[ k0 ] * ( 1 - kt ) + centred[ k0 + 1 ] * kt ) * hw;
			}

			if( sal > bestSal ) {

				bestSal = sal;
				bestPc = pc;
			}
		}

		pitchIdx[ f ] = bestPc;
		pitchSal[ f ] = bestSal;

		// Bands
		for( b = 0; b < NB; b++ ) {

			var lo = bandLo[ b ], hi = bandHi[ b ], val;

			if( lo <= hi ) {

				var s = 0;

				for( k = lo; k <= hi; k++ )
					s += magM[ k ] * magM[ k ];

				val = Math.sqrt( s / ( hi - lo + 1 ) );
			}
			else {

				var cc = bandCenter[ b ], k0 = Math.floor( cc ), t = cc - k0;
				val = magM[ k0 ] * ( 1 - t ) + magM[ Math.min( half - 1, k0 + 1 ) ] * t;
			}

			bands[ f * NB + b ] = val;
		}

		if( ( f & 511 ) === 0 )
			progress( 0.05 + 0.6 * f / nFrames, 'spectrum' );
	}

	progress( 0.66, 'tempo' );

	// ___________________________________________________ Sound region

	var energyDb = new Float32Array( nFrames );

	for( f = 0; f < nFrames; f++ )
		energyDb[ f ] = 10 * Math.log10( energy[ f ] + 1e-10 );

	var topDb = percentile( energyDb, 0.99 ),
		firstSound = 0, lastSound = nFrames - 1;

	while( firstSound < nFrames - 1 && energyDb[ firstSound ] < topDb - 45 ) firstSound++;
	while( lastSound > firstSound && energyDb[ lastSound ] < topDb - 45 ) lastSound--;

	// ___________________________________________________ Onset envelope

	var hpR = Math.round( fps * 0.5 ),
		onset = highpassNormalize( flux, hpR ),
		lowOnset = highpassNormalize( lowFlux, hpR ),
		midOnset = highpassNormalize( midFlux, hpR ),
		hiOnset = highpassNormalize( hiFlux, hpR );

	// ___________________________________________________ Tempo

	var tempo = estimateTempo( onset, fps, firstSound, lastSound ),
		period = chooseTempoOctave( tempo.period, onset, lowOnset, midOnset, fps, firstSound, lastSound ),
		bpm = 60 * fps / period;

	progress( 0.72, 'beats' );

	// ___________________________________________________ Beats

	var drumOnset = new Float32Array( nFrames );

	for( f = 0; f < nFrames; f++ )
		drumOnset[ f ] = lowOnset[ f ] + midOnset[ f ];

	var tempoCurve = localTempo( onset, fps, period, firstSound, lastSound, drumOnset ),
		beatFrames = trackBeats( onset, period, firstSound, lastSound, tempoCurve.varies ? tempoCurve.periodAt : null );

	if( beatFrames.length < 16 ) {

		// Fallback: fixed grid at the estimated tempo
		beatFrames = [];

		for( f = firstSound; f <= lastSound; f += period )
			beatFrames.push( Math.round( f ) );
	}

	var nBeats = beatFrames.length,
		beats = new Float64Array( nBeats );

	for( i = 0; i < nBeats; i++ )
		beats[ i ] = beatFrames[ i ] / fps;

	// Re-estimate the period from the tracked beats (median inter-beat interval)
	var ibis = [];

	for( i = 1; i < nBeats; i++ )
		ibis.push( beatFrames[ i ] - beatFrames[ i - 1 ] );

	period = median( ibis ) || period;
	bpm = 60 * fps / period;

	// ___________________________________________________ Vocals

	var vocals = detectVocals( vocalRaw, energyDb, topDb, fps, firstSound, lastSound, voiceCue( pitchIdx, pitchSal, fps ) );

	// ___________________________________________________ Beat-synchronous features

	var beatLoud = new Float64Array( nBeats ),
		beatBass = new Float64Array( nBeats ),
		beatOnset = new Float64Array( nBeats ),
		beatLow = new Float64Array( nBeats ),
		beatChroma = [],
		beatTimbre = [];

	for( i = 0; i < nBeats; i++ ) {

		var fa = beatFrames[ i ],
			fb = i + 1 < nBeats ? beatFrames[ i + 1 ] : Math.min( nFrames, Math.round( fa + period ) ),
			cnt = Math.max( 1, fb - fa ),
			el = 0, ebs = 0, on = 0,
			ch = new Float64Array( 12 ),
			tb = new Float64Array( 16 );

		for( f = fa; f < fa + cnt && f < nFrames; f++ ) {

			el += energy[ f ];
			ebs += bass[ f ];
			on += onset[ f ];

			for( k = 0; k < 12; k++ )
				ch[ k ] += chroma[ f * 12 + k ];

			for( b = 0; b < NB; b++ )
				tb[ b >> 2 ] += bands[ f * NB + b ] * bands[ f * NB + b ];
		}

		beatLoud[ i ] = 10 * Math.log10( el / cnt + 1e-10 );
		beatBass[ i ] = 10 * Math.log10( ebs / cnt + 1e-10 );
		beatOnset[ i ] = on / cnt;

		var lmax = 0;

		for( f = Math.max( 0, fa - 2 ); f <= Math.min( nFrames - 1, fa + 2 ); f++ )
			lmax = Math.max( lmax, lowOnset[ f ] );

		beatLow[ i ] = lmax;

		for( k = 0; k < 16; k++ )
			tb[ k ] = Math.log( tb[ k ] / cnt + 1e-9 );

		beatChroma.push( normalizeVec( ch ) );
		beatTimbre.push( tb );
	}

	// ___________________________________________________ Downbeat (bar phase, 4/4)

	var bestPhase = 0, bestScore = -Infinity, ph;

	for( ph = 0; ph < 4; ph++ ) {

		var sc = 0, n = 0;

		for( i = ph; i < nBeats; i += 4 ) {

			var change = 0;

			if( i >= 2 && i + 2 <= nBeats ) {

				var before = addVecs( beatChroma[ i - 2 ], beatChroma[ i - 1 ] ),
					after = addVecs( beatChroma[ i ], beatChroma[ i + 1 < nBeats ? i + 1 : i ] );

				change = 1 - cosine( before, after );
			}

			sc += beatLow[ i ] * 0.5 + change * 4;
			n++;
		}

		sc /= Math.max( 1, n );

		if( sc > bestScore ) {

			bestScore = sc;
			bestPhase = ph;
		}
	}

	progress( 0.8, 'structure' );

	// ___________________________________________________ Bars

	var bars = [];      // { beat, t }

	for( i = bestPhase; i + 4 <= nBeats; i += 4 )
		bars.push( i );

	var B = bars.length,
		barT = new Float64Array( B + 1 ),
		periodSec = period / fps;

	for( var m = 0; m < B; m++ )
		barT[ m ] = beats[ bars[ m ] ];

	barT[ B ] = bars[ B - 1 ] + 4 < nBeats ? beats[ bars[ B - 1 ] + 4 ] : ( B > 0 ? barT[ B - 1 ] + 4 * periodSec : duration );

	// Bar energy: loudness + onset density + bass presence, each normalized within the song
	var barLoud = new Float64Array( B ), barBass = new Float64Array( B ), barOn = new Float64Array( B ),
		barFeat = [];

	for( m = 0; m < B; m++ ) {

		var bl = 0, bbs = 0, bo = 0,
			chm = new Float64Array( 12 ),
			tbm = new Float64Array( 16 );

		for( var j = bars[ m ]; j < bars[ m ] + 4; j++ ) {

			bl += beatLoud[ j ] / 4;
			bbs += beatBass[ j ] / 4;
			bo += beatOnset[ j ] / 4;

			for( k = 0; k < 12; k++ ) chm[ k ] += beatChroma[ j ][ k ];
			for( k = 0; k < 16; k++ ) tbm[ k ] += beatTimbre[ j ][ k ] / 4;
		}

		barLoud[ m ] = bl;
		barBass[ m ] = bbs;
		barOn[ m ] = bo;
		barFeat.push( { chroma: normalizeVec( chm ), timbre: tbm } );
	}

	var nLoud = normalizeRange( barLoud, 8 ),
		nBass = normalizeRange( barBass, 10 ),
		nOn = normalizeRange( barOn, 0 ),
		E = new Float64Array( B );

	for( m = 0; m < B; m++ )
		E[ m ] = 0.5 * nLoud[ m ] + 0.25 * nBass[ m ] + 0.25 * nOn[ m ];

	// Blend in the rank within the song, so verse vs. chorus stays apart even when the song
	// also has near-silent breaks that stretch the absolute range
	var ranks = rankNormalize( E );

	for( m = 0; m < B; m++ )
		E[ m ] = 0.5 * E[ m ] + 0.5 * ranks[ m ];

	var novelty = barNovelty( barFeat, E ),
		rhythmNov = rhythmNovelty( barT, B, fps, onset, lowOnset, midOnset, hiOnset ),
		maxNov = 1e-9;

	for( m = 0; m <= B; m++ ) {

		novelty[ m ] = 0.65 * novelty[ m ] + 0.6 * rhythmNov[ m ];
		maxNov = Math.max( maxNov, novelty[ m ] );
	}

	for( m = 0; m <= B; m++ )
		novelty[ m ] /= maxNov;

	// Musical events that should start a new phase: vocal entries / exits, tempo changes
	var events = vocals.events.concat( tempoCurve.changes ),
		eventScore = new Float64Array( B + 1 );

	events.sort( function( a, b ) { return a.t - b.t; } );

	for( i = 0; i < events.length; i++ ) {

		var ev = events[ i ], bm = 0;

		for( m = 1; m <= B; m++ )
			if( Math.abs( barT[ m ] - ev.t ) < Math.abs( barT[ bm ] - ev.t ) )
				bm = m;

		if( Math.abs( barT[ bm ] - ev.t ) <= 1.5 * period / fps )
			eventScore[ bm ] = Math.max( eventScore[ bm ], ev.s );
	}

	progress( 0.86, 'choreography' );

	// ___________________________________________________ Choreography

	var endTime = Math.min( duration, lastSound / fps + 0.5 ),
		plan = planChoreography( barT, B, E, novelty, endTime, beats, periodSec, eventScore );

	refinePhases( plan, events, beats, barT, novelty, rhythmNov, endTime );

	// Beats that should not trigger beat events (phase launches, the drop, silence)
	var excluded = new Uint8Array( nBeats ),
		phaseTimes = plan.phaseTimes,
		silentDb = topDb - 32;

	for( i = 0; i < nBeats; i++ ) {

		var bt = beats[ i ];

		if( beatLoud[ i ] < silentDb )
			excluded[ i ] = 1;

		if( bt >= phaseTimes[ 15 ] - 0.05 && bt < phaseTimes[ 16 ] - 0.05 )
			excluded[ i ] = 1;

		for( var p = 2; p < 22; p++ ) {

			var phaseIndex = p + 1;

			if( phaseIndex >= 7 && phaseIndex <= 10 )
				continue;

			if( Math.abs( bt - phaseTimes[ p ] ) < 0.1 )
				excluded[ i ] = 1;
		}
	}

	// ___________________________________________________ Runtime curves (60 fps)

	progress( 0.9, 'curves' );

	var frames60 = Math.ceil( duration * 60 ) + 61,
		spectrum = new Float32Array( frames60 * NB ),
		vox = new Float32Array( frames60 ),
		bandMean = new Float64Array( NB ),
		soundCount = 0;

	for( f = firstSound; f <= lastSound; f++ ) {

		for( b = 0; b < NB; b++ )
			bandMean[ b ] += bands[ f * NB + b ];

		soundCount++;
	}

	for( b = 0; b < NB; b++ )
		bandMean[ b ] = bandMean[ b ] / Math.max( 1, soundCount ) + 1e-9;

	var voxActive = [], voxMax = 0;

	for( f = 0; f < nFrames; f++ )
		voxMax = Math.max( voxMax, voxRaw[ f ] );

	for( f = 0; f < nFrames; f++ )
		if( voxRaw[ f ] > voxMax * 0.02 )
			voxActive.push( voxRaw[ f ] );

	var voxMedian = median( voxActive ) || 1,
		voxScale = 470 / voxMedian;

	for( var g = 0; g < frames60; g++ ) {

		var x = g / 60 * fps,
			x0 = Math.floor( x ),
			tt = x - x0;

		if( x0 >= nFrames - 1 ) {

			x0 = nFrames - 2;
			tt = 1;
		}

		if( x0 < 0 )
			continue;

		for( b = 0; b < NB; b++ ) {

			var target = 110000 - 65000 * b / ( NB - 1 ),
				bv = bands[ x0 * NB + b ] * ( 1 - tt ) + bands[ ( x0 + 1 ) * NB + b ] * tt;

			spectrum[ g * NB + b ] = Math.min( 1600000, bv / bandMean[ b ] * target );
		}

		var vv = voxRaw[ x0 ] * ( 1 - tt ) + voxRaw[ x0 + 1 ] * tt;

		vox[ g ] = vv < voxMedian * 0.15 ? 0 : Math.min( 1040, vv * voxScale * ( vocals.active[ x0 ] ? 1 : 0.45 ) );
	}

	// ___________________________________________________ Hits: kick / snare / hi-hat / accents, loudness level

	progress( 0.95, 'hits' );

	var kicks = pickHits( lowOnset, fps, 0.12, firstSound, lastSound ),
		snares = pickHits( midOnset, fps, 0.1, firstSound, lastSound ),
		hats = pickHits( hiOnset, fps, 0.06, firstSound, lastSound ),
		allHits = pickHits( onset, fps, 0.15, firstSound, lastSound ),
		accentList = [];

	for( i = 0; i < allHits.length; i += 2 )
		if( allHits[ i + 1 ] >= 1.1 )
			accentList.push( allHits[ i ], allHits[ i + 1 ] );

	var accents = new Float32Array( accentList );

	// Impacts: section starts where the energy jumps (drops, chorus entries), and the end of the break
	var impacts = [], sections = plan.sections;

	for( i = 1; i < sections.length; i++ ) {

		var jump = sections[ i ].energy - sections[ i - 1 ].energy;

		if( sections[ i - 1 ].name === 'S' )
			impacts.push( sections[ i ].start, 1.5 );
		else if( jump > 0.18 )
			impacts.push( sections[ i ].start, Math.min( 1.5, 0.6 + 2 * jump ) );
	}

	// Loudness level 0..1 (fast attack, slower release), 60 fps
	var levelRaw = new Float32Array( nFrames ), env = -100,
		attack = 1 - Math.exp( -1 / ( fps * 0.03 ) ),
		release = 1 - Math.exp( -1 / ( fps * 0.3 ) );

	for( f = 0; f < nFrames; f++ ) {

		var dbv = energyDb[ f ];
		env += ( dbv - env ) * ( dbv > env ? attack : release );
		levelRaw[ f ] = env;
	}

	var soundLevels = levelRaw.subarray( firstSound, lastSound + 1 ),
		levelLo = percentile( soundLevels, 0.1 ),
		levelHi = percentile( soundLevels, 0.98 ),
		levelRange = Math.max( 6, levelHi - levelLo ),
		level = new Float32Array( frames60 );

	for( g = 0; g < frames60; g++ ) {

		var lf = Math.min( nFrames - 1, Math.round( g / 60 * fps ) );
		level[ g ] = Math.max( 0, Math.min( 1, ( levelRaw[ lf ] - ( levelHi - levelRange ) ) / levelRange ) );
	}

	// ___________________________________________________ Key (Krumhansl-Kessler)

	var total = new Float64Array( 12 );

	for( f = firstSound; f <= lastSound; f++ )
		for( k = 0; k < 12; k++ )
			total[ k ] += chroma[ f * 12 + k ];

	var key = detectKey( total );

	progress( 1, 'done' );

	return {
		duration:       duration,
		endTime:        endTime,
		bpm:            bpm,
		beatPeriod:     periodSec,
		tempoConfidence: tempo.confidence,
		beats:          Array.prototype.slice.call( beats ),
		excluded:       Array.prototype.slice.call( excluded ),
		beatStart:      phaseTimes[ 0 ] - 0.05,
		beatEnd:        Math.max( phaseTimes[ 21 ] + 1, endTime - 5 ),
		downbeat:       bestPhase,
		phaseTimes:     phaseTimes,
		sections:       plan.sections,
		energy:         Array.prototype.slice.call( E ),
		novelty:        Array.prototype.slice.call( novelty ),
		barTimes:       Array.prototype.slice.call( barT ),
		key:            key,
		spectrum:       spectrum,
		vox:            vox,
		level:          level,
		kicks:          kicks,
		snares:         snares,
		hats:           hats,
		accents:        accents,
		impacts:        impacts,
		vocalSegments:  vocals.segments,
		vocalEvents:    vocals.events,
		tempoPoints:    tempoCurve.points,
		tempoChanges:   tempoCurve.changes,
		tempoVaries:    tempoCurve.varies,
		phaseReasons:   plan.reasons,
		frames60:       frames60
	};
}

// ___________________________________________________________________________________________ Choreography planning

function planChoreography( barT, B, E, novelty, endTime, beats, periodSec, eventScore ) {

	// Intro (phase 0) ends at the biggest energy step between 3.5 s and ~32 s.
	var m1 = -1, m, bestStep = 0.2;

	for( m = 1; m < B && barT[ m ] <= 32; m++ ) {

		if( barT[ m ] < 3.5 )
			continue;

		var step = avg( E, m, Math.min( B, m + 4 ) ) - avg( E, 0, m ) + 0.3 * novelty[ m ] + 0.6 * eventScore[ m ];

		if( step > bestStep ) {

			bestStep = step;
			m1 = m;
		}
	}

	if( m1 < 0 ) {

		for( m = 0; m < B && barT[ m ] <= 24; m++ ) {

			if( barT[ m ] >= 3.5 && E[ m ] >= 0.25 ) {

				m1 = m;
				break;
			}
		}
	}

	if( m1 < 0 ) {

		m1 = 0;

		for( m = 0; m < B; m++ )
			if( Math.abs( barT[ m ] - 8 ) < Math.abs( barT[ m1 ] - 8 ) )
				m1 = m;
	}

	// Last bar at which the outro (A2) may start
	var M = m1;

	while( M + 1 < B && barT[ M + 1 ] <= endTime - 4 )
		M++;

	var macroCount = MACROS.length;

	if( B < 12 || M - m1 < macroCount - 1 )
		return proportionalPlan( barT[ Math.min( m1, B - 1 ) ] || 7, endTime );

	// Prefix sums over bar energy for O(1) segment costs
	var S1 = new Float64Array( B + 1 ), S2 = new Float64Array( B + 1 );

	for( m = 0; m < B; m++ ) {

		S1[ m + 1 ] = S1[ m ] + E[ m ];
		S2[ m + 1 ] = S2[ m ] + E[ m ] * E[ m ];
	}

	var scale = ( endTime - barT[ m1 ] ) / ORIGINAL_SPAN,
		barSec = ( barT[ B ] - barT[ 0 ] ) / Math.max( 1, B ),
		wd = PLAN_WEIGHTS.duration, wn = PLAN_WEIGHTS.novelty, we = PLAN_WEIGHTS.energy;

	function energyCost( i, j, target ) {

		var n = j - i,
			s1 = S1[ j ] - S1[ i ],
			s2 = S2[ j ] - S2[ i ];

		return s2 - 2 * target * s1 + n * target * target;
	}

	function expected( k ) {

		var total = 0, d;

		for( d = 0; d < MACROS[ k ].durs.length; d++ )
			total += MACROS[ k ].durs[ d ];

		return Math.max( barSec, total * scale );
	}

	function segCost( k, i, j ) {

		var len = barT[ j ] - barT[ i ],
			mac = MACROS[ k ],
			c;

		if( len <= 0 )
			return Infinity;

		if( mac.name === 'S' ) {

			if( j - i > 4 )
				return Infinity;

			// Breaks: low energy, followed by a rise into the final chorus. Every quiet bar of the
			// breakdown is claimed, so the whole breakdown holds still before the return.
			var after = ( E[ Math.min( B - 1, j ) ] + E[ Math.min( B - 1, j + 1 ) ] ) / 2,
				inside = ( S1[ j ] - S1[ i ] ) / ( j - i ),
				quiet = 0;

			for( var q = i; q < j; q++ )
				if( E[ q ] < 0.35 )
					quiet++;

			return 3 * energyCost( i, j, 0 ) - 3 * Math.max( 0, after - inside ) - 0.3 * quiet + 0.3 * ( j - i - 1 );
		}

		c = we * energyCost( i, j, mac.energy );
		c += wd * sq( Math.log( len / expected( k ) ) );

		return c;
	}

	function lastCost( i ) {

		var len = endTime - barT[ i ],
			bEnd = i;

		while( bEnd < B && barT[ bEnd ] < endTime )
			bEnd++;

		return we * energyCost( i, Math.max( i + 1, bEnd ), MACROS[ macroCount - 1 ].energy ) +
			wd * sq( Math.log( len / Math.min( 30, Math.max( 6, expected( macroCount - 1 ) ) ) ) );
	}

	// DP: f[k][j] = best cost with macros 0..k covering bars [m1, j)
	var f = [], from = [], k, i, j;

	for( k = 0; k < macroCount - 1; k++ ) {

		f.push( new Float64Array( B + 1 ).fill( Infinity ) );
		from.push( new Int32Array( B + 1 ).fill( -1 ) );

		for( j = m1 + k + 1; j <= M; j++ ) {

			var best = Infinity, bi = -1;

			for( i = ( k === 0 ? m1 : m1 + k ); i < j; i++ ) {

				var prev = k === 0 ? ( i === m1 ? 0 : Infinity ) : f[ k - 1 ][ i ];

				if( prev === Infinity )
					continue;

				var c = prev + segCost( k, i, j );

				if( c < best ) {

					best = c;
					bi = i;
				}
			}

			if( bi >= 0 ) {

				f[ k ][ j ] = best - wn * novelty[ j ] - PLAN_WEIGHTS.events * eventScore[ j ];
				from[ k ][ j ] = bi;
			}
		}
	}

	var lastK = macroCount - 2, bestEnd = -1, bestTotal = Infinity;

	for( j = m1 + lastK + 1; j <= M; j++ ) {

		if( f[ lastK ][ j ] === Infinity )
			continue;

		var tot = f[ lastK ][ j ] + lastCost( j );

		if( tot < bestTotal ) {

			bestTotal = tot;
			bestEnd = j;
		}
	}

	if( bestEnd < 0 )
		return proportionalPlan( barT[ m1 ], endTime );

	// Backtrack macro start bars
	var starts = [];

	starts[ macroCount - 1 ] = bestEnd;

	for( k = lastK; k >= 0; k-- )
		starts[ k ] = from[ k ][ starts[ k + 1 ] ];

	// Phase times
	var phaseTimes = [ barT[ m1 ] ],
		sections = [ { name: 'A1', label: 'intro', start: 0, end: barT[ m1 ], energy: avg( E, 0, m1 ) } ];

	for( k = 0; k < macroCount; k++ ) {

		var mac = MACROS[ k ],
			si = starts[ k ],
			ei = k + 1 < macroCount ? starts[ k + 1 ] : -1,
			tStart = barT[ si ],
			tEnd = ei >= 0 ? barT[ ei ] : endTime,
			splits = splitSection( mac.durs, si, ei >= 0 ? ei : B, tStart, tEnd, barT, beats, eventScore, novelty );

		for( var s = 1; s < splits.length; s++ )
			phaseTimes.push( splits[ s ] );

		sections.push( {
			name:   mac.name,
			label:  mac.label,
			start:  tStart,
			end:    tEnd,
			energy: avg( E, si, ei >= 0 ? ei : B )
		} );

		if( k + 1 < macroCount )
			phaseTimes.push( barT[ starts[ k + 1 ] ] );
	}

	phaseTimes.push( endTime ); // END

	return { phaseTimes: phaseTimes.slice( 0, 23 ), sections: sections };
}

// Split one macro section into its phases, proportionally to the original phase lengths,
// on bar boundaries when there are enough bars, otherwise on beats.
function splitSection( durs, barStart, barEnd, tStart, tEnd, barT, beats, eventScore, novelty ) {

	var n = durs.length,
		out = [ tStart ],
		total = 0, cum = 0, i;

	if( n === 1 )
		return out;

	for( i = 0; i < n; i++ )
		total += durs[ i ];

	var nBars = barEnd - barStart;

	if( nBars >= n ) {

		var last = barStart;

		for( i = 0; i < n - 1; i++ ) {

			cum += durs[ i ];

			var target = barStart + Math.round( nBars * cum / total ),
				lo = Math.max( last + 1, target - Math.max( 1, Math.round( nBars * durs[ i ] / total * 0.35 ) ) ),
				hi = Math.min( barEnd - ( n - 1 - i ), target + Math.max( 1, Math.round( nBars * durs[ i + 1 ] / total * 0.35 ) ) ),
				bestBar = Math.max( last + 1, Math.min( barEnd - ( n - 1 - i ), target ) ),
				bestCue = 0.3;

			// Prefer a vocal entry, tempo change or strong section change near the proportional split
			if( eventScore ) {

				for( var c = lo; c <= hi; c++ ) {

					var cue = eventScore[ c ] + 0.6 * novelty[ c ] - 0.05 * Math.abs( c - target );

					if( cue > bestCue ) {

						bestCue = cue;
						bestBar = c;
					}
				}
			}

			out.push( barT[ bestBar ] );
			last = bestBar;
		}

		return out;
	}

	// Not enough bars: snap to nearest beat
	for( i = 0; i < n - 1; i++ ) {

		cum += durs[ i ];

		var t = tStart + ( tEnd - tStart ) * cum / total;
		out.push( nearest( beats, t ) );
	}

	return out;
}

function proportionalPlan( introEnd, endTime ) {

	var original = [ 7, 24.5, 40, 48, 55.5, 64, 72, 80, 88, 96, 104, 112, 120, 128, 136, 149.75, 152, 160, 168, 176, 184, 200, 210 ],
		scale = ( endTime - introEnd ) / ORIGINAL_SPAN,
		times = [], i;

	for( i = 0; i < original.length; i++ )
		times.push( introEnd + ( original[ i ] - 7 ) * scale );

	return {
		phaseTimes: times,
		sections: [ { name: 'A1', label: 'intro', start: 0, end: introEnd, energy: 0.3 },
					{ name: 'C', label: 'chorus', start: introEnd, end: endTime, energy: 0.7 } ]
	};
}

// ___________________________________________________________________________________________ Novelty

function barNovelty( feats, E ) {

	var B = feats.length, K = 4, dims = 16, m, i, j, k;

	// z-score timbre dims across bars
	var mean = new Float64Array( dims ), std = new Float64Array( dims );

	for( m = 0; m < B; m++ )
		for( k = 0; k < dims; k++ )
			mean[ k ] += feats[ m ].timbre[ k ] / B;

	for( m = 0; m < B; m++ )
		for( k = 0; k < dims; k++ )
			std[ k ] += sq( feats[ m ].timbre[ k ] - mean[ k ] ) / B;

	for( k = 0; k < dims; k++ )
		std[ k ] = Math.sqrt( std[ k ] ) + 1e-6;

	function dist( a, b ) {

		var d = 0, x;

		for( x = 0; x < dims; x++ )
			d += sq( ( feats[ a ].timbre[ x ] - feats[ b ].timbre[ x ] ) / std[ x ] ) / dims;

		d += 2 * ( 1 - cosine( feats[ a ].chroma, feats[ b ].chroma ) );
		d += 3 * sq( E[ a ] - E[ b ] );

		return d;
	}

	var nov = new Float64Array( B + 1 ), maxN = 1e-9;

	for( m = 1; m < B; m++ ) {

		var cross = 0, within = 0, nc = 0, nw = 0;

		for( i = Math.max( 0, m - K ); i < m; i++ ) {

			for( j = m; j < Math.min( B, m + K ); j++ ) {

				cross += dist( i, j );
				nc++;
			}
		}

		for( i = Math.max( 0, m - K ); i < m; i++ )
			for( j = i + 1; j < m; j++ ) { within += dist( i, j ); nw++; }

		for( i = m; i < Math.min( B, m + K ); i++ )
			for( j = i + 1; j < Math.min( B, m + K ); j++ ) { within += dist( i, j ); nw++; }

		var v = ( nc ? cross / nc : 0 ) - ( nw ? within / nw : 0 );

		// Energy jumps are strong section cues too
		var eb = ( E[ m - 1 ] + E[ Math.max( 0, m - 2 ) ] ) / 2,
			ea = ( E[ m ] + E[ Math.min( B - 1, m + 1 ) ] ) / 2;

		v = Math.max( 0, v ) + 2 * Math.abs( ea - eb );
		nov[ m ] = v;
		maxN = Math.max( maxN, v );
	}

	for( m = 0; m <= B; m++ )
		nov[ m ] /= maxN;

	return nov;
}

// ___________________________________________________________________________________________ Tempo & beats

function estimateTempo( o, fps, f0, f1 ) {

	var minLag = Math.floor( fps * 60 / 200 ),
		maxLag = Math.ceil( fps * 60 / 55 ),
		lag120 = fps * 0.5,
		r = new Float64Array( 2 * maxLag + 2 ),
		L, t, best = -Infinity, bestL = minLag;

	for( L = 0; L < r.length; L++ ) {

		var s = 0, n = 0;

		for( t = f0; t + L <= f1; t++ ) {

			s += o[ t ] * o[ t + L ];
			n++;
		}

		r[ L ] = n ? s / n : 0;
	}

	for( L = minLag; L <= maxLag; L++ ) {

		var w = Math.exp( -0.5 * sq( Math.log2( L / lag120 ) / 1.0 ) ),
			score = w * ( r[ L ] + 0.5 * r[ 2 * L ] );

		if( score > best ) {

			best = score;
			bestL = L;
		}
	}

	// Parabolic refinement
	var a = r[ bestL - 1 ], b = r[ bestL ], c = r[ bestL + 1 ],
		den = a - 2 * b + c,
		delta = den !== 0 ? 0.5 * ( a - c ) / den : 0;

	if( Math.abs( delta ) > 1 )
		delta = 0;

	return { period: bestL + delta, confidence: r[ 0 ] > 0 ? b / r[ 0 ] : 0 };
}

// Pick the beat level among half / same / double tempo: the beat is where kick and snare
// repeat (hi-hats often play twice as fast), with a mild preference for ~110 BPM.
function chooseTempoOctave( period, onset, low, mid, fps, f0, f1 ) {

	function acf( x, L ) {

		var L0 = Math.floor( L ), w = L - L0, s0 = 0, s1 = 0, e = 0, t;

		for( t = f0; t + L0 + 1 <= f1; t++ ) {

			s0 += x[ t ] * x[ t + L0 ];
			s1 += x[ t ] * x[ t + L0 + 1 ];
			e += x[ t ] * x[ t ];
		}

		return e ? ( s0 * ( 1 - w ) + s1 * w ) / e : 0;
	}

	var best = period, bestScore = -Infinity, current = 0;

	[ period, period / 2, period * 2 ].forEach( function( p, index ) {

		var bpm = 60 * fps / p;

		if( bpm < ( index ? 70 : 55 ) || bpm > ( index ? 180 : 200 ) )
			return;

		var w = Math.exp( -0.5 * sq( Math.log2( bpm / 110 ) / 0.8 ) ),
			score = w * ( acf( low, p ) + 0.5 * acf( mid, p ) + 0.5 * acf( onset, p ) );

		// Only leave the detected octave when the drums clearly say so
		if( index === 0 )
			current = score;
		else if( score < current * 1.5 )
			return;

		if( score > bestScore ) {

			bestScore = score;
			best = p;
		}
	} );

	return best;
}

// Dynamic-programming beat tracker (Ellis 2007, as in librosa)
function trackBeats( o, period, f0, f1, periodAt ) {

	var n = o.length,
		tightness = 100,
		local = new Float64Array( n ),
		w = Math.round( period ),
		i, t, d;

	// Local score: onset envelope smoothed by a Gaussian of width period/32
	var kern = [], ks = 0;

	for( d = -w; d <= w; d++ ) {

		var kv = Math.exp( -0.5 * sq( d * 32 / period ) );
		kern.push( kv );
		ks += kv;
	}

	for( t = 0; t < n; t++ ) {

		var s = 0;

		for( d = -w; d <= w; d++ ) {

			var x = t + d;

			if( x >= 0 && x < n )
				s += o[ x ] * kern[ d + w ];
		}

		local[ t ] = s / ks;
	}

	var dMin = Math.max( 1, Math.round( period / 2 ) ),
		dMax = Math.round( period * 2 ),
		pen = new Float64Array( dMax + 1 ),
		C = new Float64Array( n ),
		P = new Int32Array( n ).fill( -1 );

	for( d = dMin; d <= dMax; d++ )
		pen[ d ] = -tightness * sq( Math.log( d / period ) );

	for( t = 0; t < n; t++ ) {

		var best = -Infinity, bi = -1,
			p = periodAt ? periodAt[ t ] : period,
			lo = periodAt ? Math.max( 1, Math.round( p / 2 ) ) : dMin,
			hi = periodAt ? Math.round( p * 2 ) : dMax;

		for( d = lo; d <= hi; d++ ) {

			var tau = t - d;

			if( tau < 0 )
				break;

			var sc = C[ tau ] + ( periodAt ? -tightness * sq( Math.log( d / p ) ) : pen[ d ] );

			if( sc > best ) {

				best = sc;
				bi = tau;
			}
		}

		C[ t ] = local[ t ] + ( bi >= 0 && best > 0 ? best : 0 );
		P[ t ] = bi >= 0 && best > 0 ? bi : -1;
	}

	// Last beat: best cumulative score within the final period of sound
	var end = Math.min( n - 1, f1 ), last = end, bestC = -Infinity;

	for( t = Math.max( 0, end - Math.round( period ) ); t <= end; t++ ) {

		if( C[ t ] > bestC ) {

			bestC = C[ t ];
			last = t;
		}
	}

	var out = [];

	for( t = last; t >= 0; t = P[ t ] )
		out.push( t );

	out.reverse();

	// Trim beats outside the sounding region
	var trimmed = [];

	for( i = 0; i < out.length; i++ )
		if( out[ i ] >= f0 - period * 0.5 && out[ i ] <= f1 )
			trimmed.push( out[ i ] );

	return trimmed;
}

// ___________________________________________________________________________________________ Key

function detectKey( chroma ) {

	var major = [ 6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88 ],
		minor = [ 6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17 ],
		names = [ 'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B' ],
		best = -Infinity, bestKey = 'C', bestMode = 'major', r, mode, prof, rot, x;

	for( mode = 0; mode < 2; mode++ ) {

		prof = mode === 0 ? major : minor;

		for( r = 0; r < 12; r++ ) {

			rot = [];

			for( x = 0; x < 12; x++ )
				rot.push( prof[ ( x - r + 12 ) % 12 ] );

			var c = pearson( chroma, rot );

			if( c > best ) {

				best = c;
				bestKey = names[ r ];
				bestMode = mode === 0 ? 'major' : 'minor';
			}
		}
	}

	return { tonic: bestKey, mode: bestMode, confidence: best };
}

// ___________________________________________________________________________________________ Utils

function makeFFT( n ) {

	var levels = Math.round( Math.log2( n ) ),
		rev = new Uint32Array( n ),
		cos = new Float64Array( n / 2 ),
		sin = new Float64Array( n / 2 ),
		i;

	for( i = 0; i < n; i++ ) {

		var r = 0, x = i;

		for( var b = 0; b < levels; b++ ) {

			r = ( r << 1 ) | ( x & 1 );
			x >>= 1;
		}

		rev[ i ] = r;
	}

	for( i = 0; i < n / 2; i++ ) {

		cos[ i ] = Math.cos( 2 * Math.PI * i / n );
		sin[ i ] = Math.sin( 2 * Math.PI * i / n );
	}

	return function( re, im ) {

		var i, j, t;

		for( i = 0; i < n; i++ ) {

			j = rev[ i ];

			if( j > i ) {

				t = re[ i ]; re[ i ] = re[ j ]; re[ j ] = t;
				t = im[ i ]; im[ i ] = im[ j ]; im[ j ] = t;
			}
		}

		for( var size = 2; size <= n; size <<= 1 ) {

			var half = size >> 1, step = n / size;

			for( var start = 0; start < n; start += size ) {

				for( var k = 0, tw = 0; k < half; k++, tw += step ) {

					var a = start + k, b = a + half,
						tre = re[ b ] * cos[ tw ] + im[ b ] * sin[ tw ],
						tim = im[ b ] * cos[ tw ] - re[ b ] * sin[ tw ];

					re[ b ] = re[ a ] - tre;
					im[ b ] = im[ a ] - tim;
					re[ a ] += tre;
					im[ a ] += tim;
				}
			}
		}
	};
}

function hann( n ) {

	var w = new Float64Array( n );

	for( var i = 0; i < n; i++ )
		w[ i ] = 0.5 - 0.5 * Math.cos( 2 * Math.PI * i / ( n - 1 ) );

	return w;
}

// ___________________________________________________________________________________________ Vocals

// Lead-vocal activity from centre-panned energy in the voice range: smoothed, split into
// "singing" / "not singing" with Otsu's threshold and hysteresis. Returns segments plus
// entry / exit events (strength 1 after a long instrumental stretch, 0.5 for a new phrase).
function detectVocals( raw, energyDb, topDb, fps, f0, f1, cue ) {

	var n = raw.length,
		x = smoothArray( raw, Math.round( fps * 0.12 ) ),
		active = new Uint8Array( n ),
		vals = [], f;

	for( f = f0; f <= f1; f++ )
		if( energyDb[ f ] > topDb - 50 )
			vals.push( x[ f ] );

	var result = { segments: [], events: [], active: active };

	if( vals.length < fps * 5 )
		return result;

	vals.sort( function( a, b ) { return a - b; } );

	var lo = vals[ Math.floor( vals.length * 0.01 ) ],
		hi = vals[ Math.floor( vals.length * 0.99 ) ],
		spread = hi - lo || 1,
		bins = 64,
		hist = new Float64Array( bins ),
		total = vals.length, sumAll = 0, wB = 0, sumB = 0, bestVar = -1, thr = ( lo + hi ) / 2, i;

	for( i = 0; i < total; i++ )
		hist[ Math.min( bins - 1, Math.max( 0, Math.floor( ( vals[ i ] - lo ) / spread * bins ) ) ) ]++;

	for( i = 0; i < bins; i++ )
		sumAll += i * hist[ i ];

	for( i = 0; i < bins; i++ ) {

		wB += hist[ i ];

		if( ! wB )
			continue;

		var wF = total - wB;

		if( ! wF )
			break;

		sumB += i * hist[ i ];

		var between = wB * wF * sq( sumB / wB - ( sumAll - sumB ) / wF );

		if( between > bestVar ) {

			bestVar = between;
			thr = lo + ( i + 0.5 ) / bins * spread;
		}
	}

	var on = thr + 0.08 * spread,
		off = thr - 0.08 * spread,
		state = false, start = 0, raw_ = [];

	for( f = f0; f <= f1; f++ ) {

		if( ! state && x[ f ] > on ) {

			state = true;
			start = f;

			// The singing started where the curve left the threshold, not where it passed "on"
			while( start > f0 && x[ start - 1 ] > thr )
				start--;
		}
		else if( state && x[ f ] < off ) {

			state = false;
			raw_.push( [ start, f ] );
		}
	}

	if( state )
		raw_.push( [ start, f1 ] );

	// Keep only the parts that also sound like a voice (pitch keeps sliding / wobbling)
	var voiced = [];

	for( i = 0; i < raw_.length; i++ ) {

		var vs = -1;

		for( f = raw_[ i ][ 0 ]; f <= raw_[ i ][ 1 ]; f++ ) {

			var isVoice = f < raw_[ i ][ 1 ] && cue[ f ] > 0.1;

			if( isVoice && vs < 0 )
				vs = f;
			else if( ! isVoice && vs >= 0 ) {

				voiced.push( [ vs, f ] );
				vs = -1;
			}
		}
	}

	raw_ = voiced;

	// Merge short gaps, drop short blips
	var segs = [];

	for( i = 0; i < raw_.length; i++ ) {

		if( segs.length && ( raw_[ i ][ 0 ] - segs[ segs.length - 1 ][ 1 ] ) / fps < 0.35 )
			segs[ segs.length - 1 ][ 1 ] = raw_[ i ][ 1 ];
		else
			segs.push( raw_[ i ].slice() );
	}

	segs = segs.filter( function( sg ) { return ( sg[ 1 ] - sg[ 0 ] ) / fps >= 0.5; } );

	for( i = 0; i < segs.length; i++ ) {

		var a = segs[ i ][ 0 ], b = segs[ i ][ 1 ],
			gapBefore = ( a - ( i ? segs[ i - 1 ][ 1 ] : f0 ) ) / fps,
			gapAfter = ( ( i + 1 < segs.length ? segs[ i + 1 ][ 0 ] : f1 ) - b ) / fps;

		for( f = a; f < b; f++ )
			active[ f ] = 1;

		result.segments.push( a / fps, b / fps );

		if( gapBefore >= 0.6 || i === 0 )
			result.events.push( { t: a / fps, s: gapBefore >= 2.5 && ( b - a ) / fps >= 2 ? 1 : 0.5, kind: 'vocal' } );

		if( gapAfter >= 2.5 )
			result.events.push( { t: b / fps, s: 0.6, kind: 'vocal-end' } );
	}

	return result;
}

// Fraction of pitched frames whose pitch moves by a small step (vibrato, slides): high for
// singing, near zero for synths, bass, keys and drums. Smoothed over ~1 s.
function voiceCue( pitchIdx, pitchSal, fps ) {

	var n = pitchIdx.length,
		w = Math.round( fps * 0.4 ),
		salThr = percentile( pitchSal, 0.3 ),
		micro = new Float32Array( n + 1 ),
		pitched = new Float32Array( n + 1 ),
		out = new Float32Array( n ),
		f;

	for( f = 1; f < n; f++ ) {

		var isPitched = pitchSal[ f ] >= salThr,
			step = Math.abs( pitchIdx[ f ] - pitchIdx[ f - 1 ] );

		pitched[ f + 1 ] = pitched[ f ] + ( isPitched ? 1 : 0 );
		micro[ f + 1 ] = micro[ f ] + ( isPitched && step > 0 && step <= 3 ? 1 : 0 );
	}

	for( f = 0; f < n; f++ ) {

		var a = Math.max( 0, f - w ), b = Math.min( n, f + w + 1 ),
			tot = pitched[ b ] - pitched[ a ];

		out[ f ] = tot > ( b - a ) * 0.5 ? ( micro[ b ] - micro[ a ] ) / tot : 0;
	}

	return smoothArray( out, Math.round( fps * 0.5 ) );
}

// ___________________________________________________________________________________________ Local tempo

// Tempo in 6 s windows every second (prior: the song's main tempo octave). Real tempo changes
// (> 6 % between the 3 s before and after) become events; the curve also drives beat tracking.
function localTempo( o, fps, globalPeriod, f0, f1, drums ) {

	var win = Math.round( 6 * fps ),
		hop = Math.round( fps ),
		minL = Math.max( Math.floor( fps * 60 / 200 ), Math.floor( globalPeriod / 1.5 ) ),
		maxL = Math.min( Math.ceil( fps * 60 / 50 ), Math.ceil( globalPeriod * 1.5 ) ),
		raw = [], times = [], valid = [], energyW = [], c, L, t, vi;

	for( c = f0; c <= f1; c += hop ) {

		var a = Math.max( 0, c - ( win >> 1 ) ),
			b = Math.min( o.length, c + ( win >> 1 ) ),
			r = new Float64Array( 2 * maxL + 2 ),
			best = -1, bl = Math.round( globalPeriod );

		for( L = 0; L < r.length; L = L === 0 ? minL : L + 1 ) {

			var sum = 0, cnt = 0;

			for( t = a; t + L < b; t++ ) {

				sum += o[ t ] * o[ t + L ];
				cnt++;
			}

			r[ L ] = cnt ? sum / cnt : 0;
		}

		for( L = minL; L <= maxL; L++ ) {

			var w = Math.exp( -0.5 * sq( Math.log2( L / globalPeriod ) / 0.6 ) ),
				score = w * ( r[ L ] + 0.5 * r[ 2 * L ] );

			if( score > best ) {

				best = score;
				bl = L;
			}
		}

		var y0 = r[ bl - 1 ], y1 = r[ bl ], y2 = r[ bl + 1 ],
			den = y0 - 2 * y1 + y2,
			d = den ? 0.5 * ( y0 - y2 ) / den : 0;

		raw.push( bl + ( Math.abs( d ) < 1 ? d : 0 ) );
		times.push( c / fps );
		var drumSum = 0;

		for( t = a; t < b; t++ )
			drumSum += drums[ t ];

		valid.push( r[ 0 ] > 0 && y1 / r[ 0 ] > 0.15 );
		energyW.push( drumSum / Math.max( 1, b - a ) );
	}

	// Windows without a clear pulse (breaks, ambient parts) take the nearest confident tempo
	var energyMed = median( energyW );

	for( vi = 0; vi < valid.length; vi++ )
		if( energyW[ vi ] < 0.35 * energyMed )
			valid[ vi ] = false;

	var anyValid = valid.indexOf( true ) >= 0, lastValid = -1;

	for( vi = 0; vi < raw.length && anyValid; vi++ ) {

		if( valid[ vi ] ) {

			lastValid = vi;
			continue;
		}

		var nextValid = vi;

		while( nextValid < raw.length && ! valid[ nextValid ] )
			nextValid++;

		raw[ vi ] = lastValid >= 0 && ( nextValid >= raw.length || vi - lastValid <= nextValid - vi ) ? raw[ lastValid ] : raw[ Math.min( nextValid, raw.length - 1 ) ];
	}

	// Median over 5 windows
	var periods = raw.map( function( v, i ) {

		var wnd = raw.slice( Math.max( 0, i - 2 ), i + 3 ).sort( function( x, y ) { return x - y; } );
		return wnd[ wnd.length >> 1 ];
	} );

	var result = { points: [], changes: [], varies: false, periodAt: null },
		i;

	for( i = 0; i < periods.length; i += 2 )
		result.points.push( times[ i ], 60 * fps / periods[ i ] );

	// Tempo varies when it stays > 5 % away from the song's usual tempo for at least ~8 s
	var usual = median( periods ), run = 0;

	for( i = 0; i < periods.length; i++ ) {

		run = Math.abs( Math.log( periods[ i ] / usual ) ) > Math.log( 1.05 ) ? run + 1 : 0;

		if( run >= 8 )
			result.varies = true;
	}

	// Change points: regions where the 3 s before / after differ by > 6 %; the change sits
	// on the biggest step of the smoothed curve inside the region
	var jumps = periods.map( function( v, k ) {

		if( k < 3 || k + 3 >= periods.length )
			return 0;

		return Math.abs( Math.log( periods[ k + 3 ] / periods[ k - 3 ] ) );
	} );

	for( i = 0; i < jumps.length; i++ ) {

		if( jumps[ i ] <= Math.log( 1.06 ) )
			continue;

		var end = i, stepAt = i, bestStep = 0;

		while( end < jumps.length && jumps[ end ] > Math.log( 1.06 ) )
			end++;

		for( var k2 = Math.max( 1, i - 3 ); k2 < Math.min( periods.length, end + 3 ); k2++ ) {

			var stp = Math.abs( Math.log( periods[ k2 ] / periods[ k2 - 1 ] ) );

			if( stp > bestStep ) {

				bestStep = stp;
				stepAt = k2;
			}
		}

		var last = result.changes[ result.changes.length - 1 ];

		if( ! last || times[ stepAt ] - last.t > 6 )
			result.changes.push( { t: times[ stepAt ], s: 1, kind: 'tempo' } );

		i = end;
	}

	if( result.varies ) {

		var periodAt = new Float32Array( o.length ), j = 0;

		for( t = 0; t < o.length; t++ ) {

			var tt = t / fps;

			while( j + 1 < times.length && times[ j + 1 ] <= tt )
				j++;

			if( j + 1 >= times.length || tt <= times[ 0 ] )
				periodAt[ t ] = periods[ tt <= times[ 0 ] ? 0 : j ];
			else
				periodAt[ t ] = periods[ j ] + ( periods[ j + 1 ] - periods[ j ] ) * ( tt - times[ j ] ) / ( times[ j + 1 ] - times[ j ] );
		}

		result.periodAt = periodAt;
	}

	return result;
}

// ___________________________________________________________________________________________ Rhythm changes

// How much the drum pattern changes at each bar: 16-step onset pattern plus kick / snare /
// hi-hat density, compared between the 2 bars before and after.
function rhythmNovelty( barT, B, fps, onset, lowOnset, midOnset, hiOnset ) {

	var vecs = [], m, s, K = 2, out = new Float64Array( B + 1 ), maxV = 1e-9;

	function sample( env, t ) {

		var f = Math.round( t * fps ), v = 0;

		for( var d = -1; d <= 1; d++ )
			if( f + d >= 0 && f + d < env.length )
				v = Math.max( v, env[ f + d ] );

		return v;
	}

	function density( env, a, b ) {

		var fa = Math.max( 0, Math.round( a * fps ) ), fb = Math.min( env.length, Math.round( b * fps ) ), sum = 0;

		for( var f = fa; f < fb; f++ )
			sum += env[ f ];

		return fb > fa ? sum / ( fb - fa ) : 0;
	}

	for( m = 0; m < B; m++ ) {

		var a = barT[ m ], b = barT[ m + 1 ], v = [];

		for( s = 0; s < 16; s++ )
			v.push( sample( onset, a + ( b - a ) * s / 16 ) );

		v = Array.prototype.slice.call( normalizeVec( v ) );
		v.push( density( lowOnset, a, b ), density( midOnset, a, b ), density( hiOnset, a, b ) );
		vecs.push( v );
	}

	function dist( i, j ) {

		var pa = vecs[ i ].slice( 0, 16 ), pb = vecs[ j ].slice( 0, 16 ), d = 1 - cosine( pa, pb );

		for( var k = 16; k < 19; k++ )
			d += 0.5 * Math.abs( vecs[ i ][ k ] - vecs[ j ][ k ] ) / ( vecs[ i ][ k ] + vecs[ j ][ k ] + 0.2 );

		return d;
	}

	for( m = 1; m < B; m++ ) {

		var cross = 0, within = 0, nc = 0, nw = 0, i, j;

		for( i = Math.max( 0, m - K ); i < m; i++ )
			for( j = m; j < Math.min( B, m + K ); j++ ) { cross += dist( i, j ); nc++; }

		for( i = Math.max( 0, m - K ); i < m; i++ )
			for( j = i + 1; j < m; j++ ) { within += dist( i, j ); nw++; }

		for( i = m; i < Math.min( B, m + K ); i++ )
			for( j = i + 1; j < Math.min( B, m + K ); j++ ) { within += dist( i, j ); nw++; }

		out[ m ] = Math.max( 0, ( nc ? cross / nc : 0 ) - ( nw ? within / nw : 0 ) );
		maxV = Math.max( maxV, out[ m ] );
	}

	for( m = 0; m <= B; m++ )
		out[ m ] /= maxV;

	return out;
}

// ___________________________________________________________________________________________ Phase refinement

// Move each phase change onto the nearest strong musical event (a vocal entry / exit or a tempo
// change) within about a bar, on the beat closest to it, and note why each phase starts there.
function refinePhases( plan, events, beats, barT, novelty, rhythmNov, endTime ) {

	var times = plan.phaseTimes,
		reasons = [],
		barLen = ( barT[ barT.length - 1 ] - barT[ 0 ] ) / Math.max( 1, barT.length - 1 ),
		beatLen = barLen / 4,
		used = {},
		i, j;

	for( i = 0; i < times.length; i++ ) {

		if( i === times.length - 1 ) {

			reasons.push( 'end' );
			break;
		}

		var t = times[ i ], best = -1, bestScore = 0;

		for( j = 0; j < events.length; j++ ) {

			var e = events[ j ], d = Math.abs( e.t - t );

			if( used[ j ] || e.s < 0.5 || d > barLen * 1.05 )
				continue;

			// The break starts when the singing stops (not when it starts); the intro lasts >= 2 s
			if( i === 15 && e.kind === 'vocal' )
				continue;

			if( i === 0 && e.t < 2 )
				continue;

			var score = e.s - 0.3 * d / barLen;

			if( score > bestScore ) {

				bestScore = score;
				best = j;
			}
		}

		var reason = 'bar';

		if( best >= 0 ) {

			var snapped = nearest( beats, events[ best ].t ),
				prev = i ? times[ i - 1 ] : 0,
				next = i + 1 < times.length ? times[ i + 1 ] : endTime;

			if( snapped > prev + beatLen * 0.9 && snapped < next - beatLen * 0.9 ) {

				times[ i ] = snapped;
				used[ best ] = true;
				reason = events[ best ].kind;
			}
		}

		if( reason === 'bar' ) {

			var bm = 0;

			for( j = 1; j < barT.length; j++ )
				if( Math.abs( barT[ j ] - t ) < Math.abs( barT[ bm ] - t ) )
					bm = j;

			if( rhythmNov[ bm ] >= 0.5 )
				reason = 'rhythm';
			else if( novelty[ bm ] >= 0.5 )
				reason = 'change';
		}

		reasons.push( reason );
	}

	plan.reasons = reasons;

	// Keep the section list in step with the refined phase times
	var startPhase = { B1: 0, C1: 2, B2: 6, C2: 10, D1: 14, S: 15, C3: 16, D2: 20, A2: 21 },
		sections = plan.sections;

	for( i = 0; i < sections.length; i++ ) {

		var idx = startPhase[ sections[ i ].name ];

		if( idx !== undefined )
			sections[ i ].start = times[ idx ];

		if( i > 0 )
			sections[ i - 1 ].end = sections[ i ].start;
	}
}

function smoothArray( x, r ) {

	var n = x.length, out = new Float32Array( n ), sum = 0, lo = 0, hi = -1;

	for( var i = 0; i < n; i++ ) {

		while( hi < Math.min( n - 1, i + r ) ) sum += x[ ++hi ];
		while( lo < i - r ) sum -= x[ lo++ ];

		out[ i ] = sum / ( hi - lo + 1 );
	}

	return out;
}

// Onset peaks: local maxima above an adaptive threshold, at least minGap apart.
// Returns a flat [ time, strength, time, strength, ... ] array; strength ~1 for a typical hit.
function pickHits( o, fps, minGap, f0, f1 ) {

	var n = o.length,
		w = 3,
		gap = Math.max( 1, Math.round( minGap * fps ) ),
		radius = Math.round( fps * 0.5 ),
		sum = new Float64Array( n + 1 ),
		out = [], last = -1e9, t, j;

	for( t = 0; t < n; t++ )
		sum[ t + 1 ] = sum[ t ] + o[ t ];

	for( t = Math.max( 1, f0 ); t <= Math.min( n - 2, f1 ); t++ ) {

		var v = o[ t ];

		if( v < 1 || t - last < gap )
			continue;

		var a = Math.max( 0, t - radius ), b = Math.min( n, t + radius + 1 ),
			mean = ( sum[ b ] - sum[ a ] ) / ( b - a );

		if( v < 0.8 + 1.5 * mean )
			continue;

		var isMax = true;

		for( j = Math.max( 0, t - w ); j <= Math.min( n - 1, t + w ); j++ ) {

			if( j !== t && o[ j ] > v ) {

				isMax = false;
				break;
			}
		}

		if( ! isMax )
			continue;

		out.push( t, v );
		last = t;
	}

	var strengths = [];

	for( t = 1; t < out.length; t += 2 )
		strengths.push( out[ t ] );

	var p90 = percentile( strengths, 0.9 ) || 1,
		res = new Float32Array( out.length );

	for( t = 0; t < out.length; t += 2 ) {

		res[ t ] = out[ t ] / fps;
		res[ t + 1 ] = Math.min( 1.5, Math.max( 0.15, out[ t + 1 ] / p90 ) );
	}

	return res;
}

// Remove slow trend (moving average), half-wave rectify, normalize by std
function highpassNormalize( x, radius ) {

	var n = x.length, out = new Float64Array( n ), sum = 0, i, lo = 0, hi = -1;

	for( i = 0; i < n; i++ ) {

		while( hi < Math.min( n - 1, i + radius ) ) sum += x[ ++hi ];
		while( lo < i - radius ) sum -= x[ lo++ ];

		out[ i ] = Math.max( 0, x[ i ] - sum / ( hi - lo + 1 ) );
	}

	var m = 0, v = 0;

	for( i = 0; i < n; i++ ) m += out[ i ] / n;
	for( i = 0; i < n; i++ ) v += sq( out[ i ] - m ) / n;

	var s = Math.sqrt( v ) || 1;

	for( i = 0; i < n; i++ )
		out[ i ] /= s;

	return out;
}

// Map values to 0..1 using the 10th..95th percentile range (at least minRange wide)
function normalizeRange( x, minRange ) {

	var lo = percentile( x, 0.1 ), hi = percentile( x, 0.95 ),
		range = Math.max( hi - lo, minRange || 1e-9 ),
		base = hi - range,
		out = new Float64Array( x.length );

	for( var i = 0; i < x.length; i++ )
		out[ i ] = Math.max( 0, Math.min( 1, ( x[ i ] - base ) / range ) );

	return out;
}

// Percentile rank of each value (0 = lowest bar, 1 = highest)
function rankNormalize( x ) {

	var n = x.length, idx = [], out = new Float64Array( n ), i;

	for( i = 0; i < n; i++ )
		idx.push( i );

	idx.sort( function( a, b ) { return x[ a ] - x[ b ]; } );

	for( i = 0; i < n; i++ )
		out[ idx[ i ] ] = n > 1 ? i / ( n - 1 ) : 0.5;

	return out;
}

function percentile( x, p ) {

	if( ! x.length )
		return 0;

	var a = Array.prototype.slice.call( x ).sort( function( a, b ) { return a - b; } );

	return a[ Math.min( a.length - 1, Math.max( 0, Math.floor( p * ( a.length - 1 ) ) ) ) ];
}

function median( x ) {

	return x.length ? percentile( x, 0.5 ) : 0;
}

function nearest( arr, t ) {

	var best = t, bd = Infinity;

	for( var i = 0; i < arr.length; i++ ) {

		var d = Math.abs( arr[ i ] - t );

		if( d < bd ) {

			bd = d;
			best = arr[ i ];
		}
	}

	return best;
}

function avg( x, i, j ) {

	var s = 0, n = 0;

	for( var k = i; k < j && k < x.length; k++ ) {

		s += x[ k ];
		n++;
	}

	return n ? s / n : 0;
}

function normalizeVec( v ) {

	var s = 0, i, out = new Float64Array( v.length );

	for( i = 0; i < v.length; i++ ) s += v[ i ] * v[ i ];

	s = Math.sqrt( s ) || 1;

	for( i = 0; i < v.length; i++ ) out[ i ] = v[ i ] / s;

	return out;
}

function addVecs( a, b ) {

	var out = new Float64Array( a.length );

	for( var i = 0; i < a.length; i++ ) out[ i ] = a[ i ] + b[ i ];

	return out;
}

function cosine( a, b ) {

	var d = 0, na = 0, nb = 0;

	for( var i = 0; i < a.length; i++ ) {

		d += a[ i ] * b[ i ];
		na += a[ i ] * a[ i ];
		nb += b[ i ] * b[ i ];
	}

	return na && nb ? d / Math.sqrt( na * nb ) : 0;
}

function pearson( a, b ) {

	var n = a.length, ma = 0, mb = 0, i, num = 0, da = 0, db = 0;

	for( i = 0; i < n; i++ ) { ma += a[ i ] / n; mb += b[ i ] / n; }

	for( i = 0; i < n; i++ ) {

		num += ( a[ i ] - ma ) * ( b[ i ] - mb );
		da += sq( a[ i ] - ma );
		db += sq( b[ i ] - mb );
	}

	return da && db ? num / Math.sqrt( da * db ) : 0;
}

function sq( x ) {

	return x * x;
}
