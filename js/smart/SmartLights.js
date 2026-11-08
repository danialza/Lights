/**
 * Lights Smart — lets the Lights experience follow any song.
 *
 *  - Uploaded files are analyzed up front (js/smart/analyzer-worker.js): tempo, beat grid, bars,
 *    song structure (intro / verse / chorus / bridge / drop / outro), vocal energy and spectrum.
 *    The structure is mapped onto the 23 choreography phases of the original experience.
 *  - Live audio (a browser tab, the whole system, or the microphone) is analyzed in real time:
 *    beats are tracked with a tempo estimator + phase-locked loop, and phases advance on bar
 *    boundaries when the energy of the music changes (drops, choruses, breaks).
 *
 * Loaded after js/Lights.js; it only patches prototypes, the original code stays untouched.
 */

( function() {

'use strict';

var NB = 64,
	PHASE_SECTION = [ 'A1', 'B1', 'B1', 'C1', 'C1', 'C1', 'C1', 'B2', 'B2', 'B2', 'B2', 'C2', 'C2', 'C2', 'C2', 'D1', 'S', 'C3', 'C3', 'C3', 'C3', 'D2', 'A2', 'END' ],
	SECTION_LABEL = { A1: 'intro', B1: 'verse', C1: 'chorus', B2: 'verse', C2: 'chorus', D1: 'bridge', S: 'drop', C3: 'chorus', D2: 'bridge', A2: 'outro', C: 'chorus', END: 'outro' },
	LABEL_TEXT = { intro: 'Intro', verse: 'Verse', chorus: 'Chorus', bridge: 'Bridge', drop: 'Break', outro: 'Outro' },
	// Phase lengths of the original song in bars (120 BPM, 2 s per bar); used by the live director
	PHASE_BARS = [ 4, 9, 8, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 7, 1, 4, 4, 4, 4, 8, 5 ],
	STEP_TEXT = {
		decode:       'Reading file',
		spectrum:     'Analyzing spectrum',
		tempo:        'Finding the tempo',
		beats:        'Tracking beats',
		structure:    'Detecting song sections',
		choreography: 'Mapping the light show onto the sections',
		curves:       'Preparing vocal and spectrum curves',
		hits:         'Detecting kicks, snares and hi-hats',
		done:         'Done'
	};

var Smart = LIGHTS.Smart = {

	mode:           null,       // 'original' | 'file' | 'live'
	ready:          false,
	busy:           false,
	track:          null,       // analysis result (file mode)
	live:           null,       // LiveEngine (live mode)
	title:          '',
	cover:          null,       // Image (album art) when available
	ctx:            null,
	hud:            false,
	originalTimes:  LIGHTS.Music.phase.times.slice(),
	readyCallbacks: [],
	spectrumBuffer: new Float32Array( NB ),

	whenReady: function( callback ) {

		if( this.ready )
			callback();
		else
			this.readyCallbacks.push( callback );
	},

	getContext: function() {

		if( ! this.ctx )
			this.ctx = new ( window.AudioContext || window.webkitAudioContext )();

		return this.ctx;
	},

	// Camera speed follows the tempo (the original choreography was made for 120 BPM)
	speedFactor: function() {

		var bpm = this.mode === 'file' ? this.track.bpm : this.mode === 'live' ? this.live.bpm : 120;

		return Math.max( 0.75, Math.min( 1.35, Math.pow( bpm / 120, 0.6 ) ) );
	},

	getSpectrum: function( frame ) {

		if( this.mode === 'file' ) {

			var track = this.track,
				f = Math.min( frame, track.frames60 - 1 ) * NB,
				out = this.spectrumBuffer;

			for( var b = 0; b < NB; b++ )
				out[ b ] = track.spectrum[ f + b ];

			return out;
		}

		if( this.mode === 'live' )
			return this.live.spectrum;

		return null;
	},

	voxAt: function( frame ) {

		if( this.mode === 'file' )
			return this.track.vox[ frame ] || 0;

		if( this.mode === 'live' )
			return this.live.vox;

		return LIGHTS.VolumeData.vox[ frame ] || 0;
	},

	// Audio position of the current source
	clockTime: function() {

		var music = LIGHTS.musicAudio;

		return music ? music.currentTime : 0;
	},

	// The player's position (currentTime) already accounts for the sound card's latency in
	// Chrome, so the visuals only run ahead by the time a frame takes to reach the screen.
	// Speakers that add their own delay (Bluetooth, TVs) are measured with the tap-along
	// calibration (T) or trimmed with [ and ] during playback; both are saved in this browser.
	syncOffset: loadOffset(),
	audioDelay: loadSetting( 'lightsSmartAudioDelay', 0 ),
	displayLatency: 0.035,

	lead: function() {

		if( this.mode !== 'file' )
			return 0;

		return this.displayLatency - this.audioDelay + this.syncOffset / 1000;
	},

	// Song time the visuals should show now
	now: function() {

		return LIGHTS.time + ( this.mode === 'file' ? this.appliedLead : 0 );
	},

	appliedLead: 0,

	// Keep the visual lead current (the show program schedules phases with it)
	applyLead: function( force ) {

		if( this.mode !== 'file' )
			return;

		var lead = this.lead();

		if( force || Math.abs( lead - this.appliedLead ) >= 0.005 )
			this.appliedLead = lead;
	},

	sectionAt: function( time ) {

		if( this.mode === 'file' ) {

			var sections = this.track.sections;

			for( var i = sections.length - 1; i >= 0; i-- )
				if( time >= sections[ i ].start )
					return sections[ i ].label;
		}

		return SECTION_LABEL[ PHASE_SECTION[ LIGHTS.Music.phase.index ] ] || '';
	}
};

function loadOffset() {

	try {

		return parseInt( localStorage.getItem( 'lightsSmartOffset' ), 10 ) || 0;
	}
	catch( e ) {

		return 0;
	}
}

function loadSetting( key, fallback ) {

	try {

		var v = parseFloat( localStorage.getItem( key ) );

		return isNaN( v ) ? fallback : v;
	}
	catch( e ) {

		return fallback;
	}
}

function saveSetting( key, value ) {

	try {

		localStorage.setItem( key, String( value ) );
	}
	catch( e ) {}
}

function saveOffset( value ) {

	try {

		localStorage.setItem( 'lightsSmartOffset', String( value ) );
	}
	catch( e ) {}
}

// _______________________________________________________________________________________________ Sources

function setSource( mode, audio, title ) {

	Smart.mode = mode;
	Smart.title = title;
	LIGHTS.musicAudio = audio;
	Smart.ready = true;
	Smart.busy = false;

	applyVisualIdentity();
	UI.showReady();

	var callbacks = Smart.readyCallbacks;
	Smart.readyCallbacks = [];

	for( var i = 0; i < callbacks.length; i++ )
		callbacks[ i ]();
}

function unsetSource() {

	Smart.ready = false;

	if( Smart.live ) {

		Smart.live.dispose();
		Smart.live = null;
	}

	if( LIGHTS.musicAudio && LIGHTS.musicAudio.pause )
		LIGHTS.musicAudio.pause();
}

function useOriginal() {

	if( Smart.busy )
		return;

	unsetSource();
	Smart.busy = true;
	Smart.cover = null;
	UI.showBusy( 'Preparing the original song…', 0.3 );

	var audio = document.createElement( 'audio' );

	audio.preload = 'auto';
	audio.src = audio.canPlayType( 'audio/mpeg' ) ? LIGHTS.Config.musicMP3 : LIGHTS.Config.musicOGG;

	whenPlayable( audio ).then( function() {

		Smart.track = null;
		setSource( 'original', audio, 'Ellie Goulding — Lights' );

	} ).catch( function() {

		fail( 'The original song file could not be found.' );
	} );
}

function useFile( file, options ) {

	options = options || {};

	if( Smart.busy || ! file )
		return;

	if( file.type && ! /^audio\/|^video\//.test( file.type ) ) {

		UI.showError( 'That is not an audio file. Choose an MP3, WAV, OGG, M4A or FLAC file.' );
		return;
	}

	unsetSource();
	Smart.busy = true;
	UI.showBusy( STEP_TEXT.decode + '…', 0.02 );

	var ctx = Smart.getContext(),
		tags = null,
		url = URL.createObjectURL( file );

	readFile( file ).then( function( buffer ) {

		tags = parseID3( buffer );
		UI.showBusy( 'Decoding audio…', 0.04 );

		return decodeAudio( ctx, buffer );

	} ).then( function( audioBuffer ) {

		var prepared = prepareSignal( audioBuffer );

		return runAnalyzer( prepared );

	} ).then( function( result ) {

		var audio = document.createElement( 'audio' );

		audio.preload = 'auto';
		audio.src = url;

		return whenPlayable( audio ).then( function() {

			if( Smart.objectURL )
				URL.revokeObjectURL( Smart.objectURL );

			Smart.objectURL = url;
			Smart.track = result;
			Pulse.build( result );

			var tagTitle = cleanTag( tags && tags.title ),
				tagArtist = cleanTag( tags && tags.artist ),
				title = tagTitle ? ( tagArtist ? tagArtist + ' — ' : '' ) + tagTitle : cleanTag( file.name.replace( /\.[^.]+$/, '' ) ) || file.name;

			return loadCover( tags && tags.picture ).then( function( cover ) {

				Smart.cover = cover;
				Show.choose( result, title );
				setSource( 'file', audio, title );

				// Uploaded songs are kept in this browser so the page can offer them next time
				if( options.remember )
					SongStore.save( file, title ).then( function() { UI.listMine(); } );
				else if( options.savedId )
					SongStore.touch( options.savedId );
			} );
		} );

	} ).catch( function( err ) {

		console.error( err );
		URL.revokeObjectURL( url );
		fail( 'This file could not be played or analyzed. Try another format (for example MP3).' );
	} );
}

function useLive( kind ) {

	if( Smart.busy )
		return;

	var media = navigator.mediaDevices;

	if( ! media || ( kind === 'display' ? ! media.getDisplayMedia : ! media.getUserMedia ) ) {

		UI.showError( kind === 'display' ?
			'This browser cannot capture playing audio. Use Chrome or Edge on desktop.' :
			'This browser does not allow microphone access.' );
		return;
	}

	unsetSource();
	Smart.busy = true;
	Smart.cover = null;

	var ctx = Smart.getContext(),
		clean = { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
		request;

	ctx.resume();

	if( kind === 'display' ) {

		UI.showBusy( 'In the dialog that opens, pick a tab or your entire screen and turn on “Share audio”.', 0.5 );
		request = media.getDisplayMedia( { video: true, audio: clean, systemAudio: 'include', selfBrowserSurface: 'exclude' } );
	}
	else {

		UI.showBusy( 'Allow microphone access…', 0.5 );
		request = media.getUserMedia( { audio: clean } );
	}

	request.then( function( stream ) {

		if( ! stream.getAudioTracks().length ) {

			stream.getTracks().forEach( function( t ) { t.stop(); } );
			throw { smartNoAudio: true };
		}

		// Only the sound is needed
		stream.getVideoTracks().forEach( function( t ) { t.enabled = false; } );

		startLive( stream, kind === 'display' ? 'Playing audio' : 'Microphone' );

	} ).catch( function( err ) {

		console.error( err );
		fail( err && err.smartNoAudio ?
			'No audio was shared. When picking the tab or screen, turn on “Share audio”.' :
			'Access was denied or cancelled.' );
	} );
}

// Any audio MediaStream can drive the live mode (also used for testing)
function startLive( stream, title ) {

	var ctx = Smart.getContext(),
		live = Smart.live = new LiveEngine( ctx, stream );

	stream.getAudioTracks()[ 0 ].addEventListener( 'ended', function() {

		if( Smart.live !== live )
			return;

		if( LIGHTS.Lights.instance.experiencePlaying )
			live.requestStop();

		Smart.ready = false;
		UI.showError( 'Audio sharing stopped. Choose a source again.' );
	} );

	setSource( 'live', live.clock, title );
}

Smart.useStream = function( stream, title ) {

	unsetSource();
	startLive( stream, title || 'Live audio' );
};
// Songs the visitor added, kept in this browser's IndexedDB. Nothing is uploaded anywhere:
// opening the page again on the same computer just offers them as buttons and loads the
// most recent one.
var SongStore = {

	maxSongs: 8,
	maxBytes: 200 * 1024 * 1024,

	open: function() {

		if( this.ready )
			return this.ready;

		this.ready = new Promise( function( resolve ) {

			try {

				var request = indexedDB.open( 'lights-smart', 1 );

				request.onupgradeneeded = function() {

					request.result.createObjectStore( 'songs', { keyPath: 'id' } );
				};
				request.onsuccess = function() { resolve( request.result ); };
				request.onerror = function() { resolve( null ); };
				request.onblocked = function() { resolve( null ); };
			}
			catch( e ) {

				resolve( null );
			}
		} );

		return this.ready;
	},

	// Newest first, without the audio data
	list: function() {

		return this.open().then( function( db ) {

			return new Promise( function( resolve ) {

				if( ! db )
					return resolve( [] );

				try {

					var songs = [],
						cursor = db.transaction( 'songs' ).objectStore( 'songs' ).openCursor();

					cursor.onsuccess = function( e ) {

						var c = e.target.result;

						if( c ) {

							songs.push( { id: c.value.id, name: c.value.name, title: c.value.title, size: c.value.size, used: c.value.used } );
							c.continue();
						}
						else {

							resolve( songs.sort( function( a, b ) { return b.used - a.used; } ) );
						}
					};
					cursor.onerror = function() { resolve( [] ); };
				}
				catch( e ) {

					resolve( [] );
				}
			} );
		} );
	},

	request: function( mode, work ) {

		return this.open().then( function( db ) {

			return new Promise( function( resolve ) {

				if( ! db )
					return resolve( null );

				try {

					var tx = db.transaction( 'songs', mode ),
						result = work( tx.objectStore( 'songs' ) );

					tx.oncomplete = function() { resolve( result && result.result !== undefined ? result.result : null ); };
					tx.onerror = tx.onabort = function() { resolve( null ); };
				}
				catch( e ) {

					resolve( null );
				}
			} );
		} );
	},

	get: function( id ) {

		return this.request( 'readonly', function( store ) { return store.get( id ); } );
	},

	save: function( file, title ) {

		var self = this;

		if( ! file || file.size > 60 * 1024 * 1024 )
			return Promise.resolve();

		return this.request( 'readwrite', function( store ) {

			store.put( { id: file.name + '|' + file.size, name: file.name, title: title || '', type: file.type, size: file.size, blob: file, used: Date.now() } );

		} ).then( function() {

			// Keep the newest few, within a size budget
			return self.list();

		} ).then( function( songs ) {

			var total = 0, drop = [];

			songs.forEach( function( song, i ) {

				total += song.size;

				if( i >= self.maxSongs || total > self.maxBytes )
					drop.push( song.id );
			} );

			return Promise.all( drop.map( function( id ) { return self.remove( id ); } ) );
		} );
	},

	touch: function( id ) {

		return this.request( 'readwrite', function( store ) {

			var req = store.get( id );

			req.onsuccess = function() {

				if( req.result ) {

					req.result.used = Date.now();
					store.put( req.result );
				}
			};
		} );
	},

	remove: function( id ) {

		return this.request( 'readwrite', function( store ) { store.delete( id ); } );
	}
};

function useSaved( id ) {

	if( Smart.busy )
		return;

	SongStore.get( id ).then( function( song ) {

		if( ! song || ! song.blob ) {

			UI.showError( 'That song is no longer saved in this browser.' );
			UI.listMine();
			return;
		}

		useFile( new File( [ song.blob ], song.name, { type: song.type || song.blob.type || 'audio/mpeg' } ), { savedId: id } );
	} );
}

function useUrl( url, name ) {

	if( Smart.busy )
		return;

	UI.showBusy( 'Loading ' + name + '…', 0.01 );

	fetch( url ).then( function( r ) {

		if( ! r.ok )
			throw new Error( r.status );

		return r.blob();

	} ).then( function( blob ) {

		useFile( new File( [ blob ], decodeURIComponent( url.split( '/' ).pop() ), { type: blob.type || 'audio/mpeg' } ) );

	} ).catch( function() {

		UI.showError( 'Could not load ' + name + '.' );
	} );
}

function escapeHtml( text ) {

	return String( text ).replace( /[&<>"']/g, function( c ) {

		return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ c ];
	} );
}

Smart.useFile = useFile;
Smart.useLive = useLive;
Smart.useOriginal = useOriginal;

function fail( message ) {

	Smart.busy = false;
	UI.showError( message );
}

// _______________________________________________________________________________________________ File helpers

function readFile( file ) {

	if( file.arrayBuffer )
		return file.arrayBuffer();

	return new Promise( function( resolve, reject ) {

		var reader = new FileReader();
		reader.onload = function() { resolve( reader.result ); };
		reader.onerror = reject;
		reader.readAsArrayBuffer( file );
	} );
}

// Decode straight to 22,050 Hz (the analysis rate) with the browser's resampler, so the analysis
// is the same on every machine whatever its sound card runs at
function decodeAudio( ctx, buffer ) {

	var Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext,
		decoder = ctx;

	try {

		if( Offline )
			decoder = new Offline( 2, 1, 22050 );
	}
	catch( e ) {}

	return new Promise( function( resolve, reject ) {

		var copy = decoder !== ctx ? buffer.slice( 0 ) : null,
			fellBack = false,
			fallback = function( err ) {

				if( fellBack )
					return;

				if( ! copy )
					return reject( err );

				var again = copy;

				fellBack = true;

				var q = ctx.decodeAudioData( again, resolve, reject );

				if( q && q.then )
					q.then( resolve, reject );
			},
			p = decoder.decodeAudioData( buffer, resolve, fallback );

		if( p && p.then )
			p.then( resolve, fallback );
	} );
}

function whenPlayable( audio ) {

	return new Promise( function( resolve, reject ) {

		if( audio.readyState >= 3 )
			return resolve();

		var done = function() {

			audio.removeEventListener( 'canplay', done );
			resolve();
		};

		audio.addEventListener( 'canplay', done );
		audio.addEventListener( 'error', reject );
		audio.load();
	} );
}

// Down-mix to mid / side and decimate to ~22 kHz (enough for the analysis, 4x less work)
function prepareSignal( audioBuffer ) {

	var sr = audioBuffer.sampleRate,
		left = audioBuffer.getChannelData( 0 ),
		right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData( 1 ) : left,
		factor = Math.max( 1, Math.round( sr / 22050 ) ),
		n = Math.floor( left.length / factor ),
		mid = new Float32Array( n ),
		side = new Float32Array( n ),
		i, j, m, s, base;

	for( i = 0; i < n; i++ ) {

		m = s = 0;
		base = i * factor;

		for( j = 0; j < factor; j++ ) {

			m += left[ base + j ] + right[ base + j ];
			s += left[ base + j ] - right[ base + j ];
		}

		mid[ i ] = m / ( 2 * factor );
		side[ i ] = s / ( 2 * factor );
	}

	return { mid: mid, side: side, sampleRate: sr / factor };
}

function runAnalyzer( prepared ) {

	return new Promise( function( resolve, reject ) {

		var worker = new Worker( 'js/smart/analyzer-worker.js?v=10' );

		worker.onmessage = function( e ) {

			var d = e.data;

			if( d.type === 'progress' ) {

				UI.showBusy( ( STEP_TEXT[ d.label ] || '' ) + '…', 0.05 + 0.95 * d.p );
			}
			else if( d.type === 'done' ) {

				worker.terminate();
				resolve( d.result );
			}
			else {

				worker.terminate();
				reject( new Error( d.message ) );
			}
		};

		worker.onerror = function( e ) {

			worker.terminate();
			reject( new Error( e.message ) );
		};

		worker.postMessage( prepared, [ prepared.mid.buffer, prepared.side.buffer ] );
	} );
}

// Minimal ID3v2.3 / 2.4 reader: title, artist and cover picture
function parseID3( buffer ) {

	try {

		var view = new DataView( buffer ),
			bytes = new Uint8Array( buffer );

		if( buffer.byteLength < 10 || bytes[ 0 ] !== 0x49 || bytes[ 1 ] !== 0x44 || bytes[ 2 ] !== 0x33 )
			return null;

		var version = bytes[ 3 ],
			flags = bytes[ 5 ],
			syncsafe = function( p ) {
				return ( bytes[ p ] << 21 ) | ( bytes[ p + 1 ] << 14 ) | ( bytes[ p + 2 ] << 7 ) | bytes[ p + 3 ];
			},
			end = Math.min( buffer.byteLength, 10 + syncsafe( 6 ) ),
			pos = 10,
			out = {};

		if( version < 3 )
			return null;

		if( flags & 0x40 )
			pos += version === 4 ? syncsafe( 10 ) : view.getUint32( 10 ) + 4;

		while( pos + 10 <= end ) {

			var id = String.fromCharCode( bytes[ pos ], bytes[ pos + 1 ], bytes[ pos + 2 ], bytes[ pos + 3 ] );

			if( ! /^[A-Z0-9]{4}$/.test( id ) )
				break;

			var size = version === 4 ? syncsafe( pos + 4 ) : view.getUint32( pos + 4 ),
				body = pos + 10;

			if( size <= 0 || body + size > end )
				break;

			var frame = bytes.subarray( body, body + size );

			if( id === 'TIT2' )
				out.title = decodeID3Text( frame[ 0 ], frame.subarray( 1 ) );
			else if( id === 'TPE1' )
				out.artist = decodeID3Text( frame[ 0 ], frame.subarray( 1 ) );
			else if( id === 'APIC' && ! out.picture )
				out.picture = parseAPIC( frame );

			pos = body + size;
		}

		return out;
	}
	catch( e ) {

		return null;
	}
}

// Strip download-site watermarks such as "[ SiteName.ir ]" or "(www.site.com)" from tags
function cleanTag( text ) {

	if( ! text )
		return '';

	return text
		.replace( /[\[\(\{][^\]\)\}]*(\.[a-z]{2,4}\b|www\.|https?:)[^\]\)\}]*[\]\)\}]/gi, '' )
		.replace( /\s*[-|@]?\s*(https?:\/\/)?(www\.)?[a-z0-9-]+\.(ir|com|net|org|info|me|co|io|to|fm)\b\S*/gi, '' )
		.replace( /[_]+/g, ' ' )
		.replace( /\s{2,}/g, ' ' )
		.replace( /^[\s\-–—|]+|[\s\-–—|]+$/g, '' );
}

function decodeID3Text( encoding, data ) {

	var label = [ 'windows-1252', 'utf-16', 'utf-16be', 'utf-8' ][ encoding ] || 'utf-8';

	return new TextDecoder( label ).decode( data ).replace( /\u0000/g, '' ).trim();
}

function parseAPIC( frame ) {

	var encoding = frame[ 0 ], p = 1, mime = '';

	while( p < frame.length && frame[ p ] !== 0 )
		mime += String.fromCharCode( frame[ p++ ] );

	p += 2; // null + picture type

	if( encoding === 1 || encoding === 2 ) {

		while( p + 1 < frame.length && ! ( frame[ p ] === 0 && frame[ p + 1 ] === 0 ) ) p += 2;
		p += 2;
	}
	else {

		while( p < frame.length && frame[ p ] !== 0 ) p++;
		p += 1;
	}

	if( mime.indexOf( '/' ) < 0 )
		mime = 'image/' + ( mime.toLowerCase() || 'jpeg' );

	return p < frame.length ? new Blob( [ frame.slice( p ) ], { type: mime } ) : null;
}

function loadCover( blob ) {

	return new Promise( function( resolve ) {

		if( ! blob )
			return resolve( null );

		var img = new Image(),
			url = URL.createObjectURL( blob );

		img.onload = function() { resolve( img ); };
		img.onerror = function() { resolve( null ); };
		img.src = url;
	} );
}

// _______________________________________________________________________________________________ Visual identity

// The dot avatars on the terrain: Ellie Goulding & label logos for the original song,
// the album art (when the file has one) or generated music icons for anything else.
function applyVisualIdentity() {

	var app = LIGHTS.Lights.instance,
		director = app && app.director;

	if( ! director )
		return;

	var dots = director.tileManager.terrainDots,
		avatars = dots && dots.avatars,
		i, images = [];

	if( ! avatars )
		return;

	for( i = 0; i < avatars.length; i++ ) {

		if( Smart.mode === 'original' )
			images.push( LIGHTS.images[ i % 2 === 0 ? 'ellieAvatar' + ( i >> 1 ) : 'avatar' + ( i >> 1 ) ] );
		else if( Smart.cover && i % 2 === 0 )
			images.push( Smart.cover );
		else
			images.push( iconCanvas( i ) );
	}

	for( i = 0; i < avatars.length; i++ ) {

		if( ! images[ i ] || ! avatars[ i ].dots )
			continue;

		var avatar = avatars[ i ],
			sample = { opacity: LIGHTS.TerrainDotAvatar.prototype.opacity };

		LIGHTS.TerrainDotAvatar.prototype.initialize.call( sample, images[ i ], avatar.width, avatar.height );

		for( var x = 0; x < avatar.width; x++ ) {

			for( var y = 0; y < avatar.height; y++ ) {

				var color = avatar.dots[ x ][ y ].avatarColor,
					c = sample.colors[ x ][ y ];

				color.r = c[ 0 ];
				color.g = c[ 1 ];
				color.b = c[ 2 ];
			}
		}
	}
}

function iconCanvas( index ) {

	var size = 22,
		canvas = document.createElement( 'canvas' ),
		g = canvas.getContext( '2d' ),
		hex = LIGHTS.colors[ index % LIGHTS.colors.length ],
		color = '#' + ( '000000' + hex.toString( 16 ) ).slice( -6 ),
		i;

	canvas.width = canvas.height = size;
	g.fillStyle = '#000';
	g.fillRect( 0, 0, size, size );
	g.fillStyle = g.strokeStyle = color;

	switch( index % 3 ) {

		case 0: // equalizer
			var heights = [ 8, 16, 11, 19, 6 ];
			for( i = 0; i < 5; i++ )
				g.fillRect( 2 + i * 4, size - 2 - heights[ i ], 3, heights[ i ] );
			break;

		case 1: // rings
			g.lineWidth = 2;
			for( i = 3; i <= 9; i += 3 ) {
				g.beginPath();
				g.arc( 11, 11, i, 0, Math.PI * 2 );
				g.stroke();
			}
			break;

		default: // note
			g.beginPath();
			g.ellipse( 7, 16, 4, 3, -0.4, 0, Math.PI * 2 );
			g.fill();
			g.fillRect( 10, 3, 2, 13 );
			g.fillRect( 10, 3, 8, 3 );
			break;
	}

	return canvas;
}

// _______________________________________________________________________________________________ Live engine

function LiveEngine( ctx, stream ) {

	var self = this;

	this.ctx = ctx;
	this.stream = stream;
	this.source = ctx.createMediaStreamSource( stream );
	this.analyser = ctx.createAnalyser();
	this.analyser.fftSize = 2048;
	this.analyser.smoothingTimeConstant = 0;
	this.source.connect( this.analyser );

	// Side signal ( L - R ) / 2: the lead vocal sits in the centre, so centre minus side
	// isolates it. A mono source is first up-mixed to two identical channels.
	this.stereo = ctx.createGain();
	this.stereo.channelCount = 2;
	this.stereo.channelCountMode = 'explicit';
	this.stereo.channelInterpretation = 'speakers';
	this.splitter = ctx.createChannelSplitter( 2 );
	this.sideL = ctx.createGain();
	this.sideL.gain.value = 0.5;
	this.sideR = ctx.createGain();
	this.sideR.gain.value = -0.5;
	this.sideAnalyser = ctx.createAnalyser();
	this.sideAnalyser.fftSize = 2048;
	this.sideAnalyser.smoothingTimeConstant = 0;
	this.source.connect( this.stereo );
	this.stereo.connect( this.splitter );
	this.splitter.connect( this.sideL, 0 );
	this.splitter.connect( this.sideR, 1 );
	this.sideL.connect( this.sideAnalyser );
	this.sideR.connect( this.sideAnalyser );

	// Keep the graph pulled without making any sound
	this.sink = ctx.createGain();
	this.sink.gain.value = 0;
	this.analyser.connect( this.sink );
	this.sideAnalyser.connect( this.sink );
	this.sink.connect( ctx.destination );

	var bins = this.analyser.frequencyBinCount,
		binHz = ctx.sampleRate / this.analyser.fftSize,
		fHi = Math.min( 10000, ctx.sampleRate * 0.48 ),
		b;

	this.bins = bins;
	this.sideDb = new Float32Array( bins );
	this.centred = new Float32Array( bins );
	this.pitchBins = [];

	for( var pc = 0; 110 * Math.pow( 2, pc / 96 ) < 800; pc++ )
		this.pitchBins.push( 110 * Math.pow( 2, pc / 96 ) / binHz );

	this.pitchHi = Math.min( bins - 1, Math.ceil( 4900 / binHz ) );
	this.prevPitch = 0;
	this.salMean = 0;
	this.microE = this.pitchedE = 0;
	this.vocalMean = 0;
	this.vocalVar = 1;
	this.vocalOn = false;
	this.vocalActiveSince = -1;
	this.vocalQuietSince = -1;
	this.vocalOffAt = -100;
	this.vocalEntryPending = 0;
	this.tempoChangePending = 0;
	this.bpmRef = 0;
	this.tempoDevSince = 0;
	this.lastReason = '';
	this.db = new Float32Array( bins );
	this.mag = new Float32Array( bins );
	this.logPrev = new Float32Array( bins );
	this.bandLo = new Int32Array( NB );
	this.bandHi = new Int32Array( NB );
	this.bandCenter = new Float32Array( NB );

	for( b = 0; b < NB; b++ ) {

		var f0 = 40 * Math.pow( fHi / 40, b / NB ),
			f1 = 40 * Math.pow( fHi / 40, ( b + 1 ) / NB );

		this.bandLo[ b ] = Math.ceil( f0 / binHz );
		this.bandHi[ b ] = Math.min( bins - 1, Math.floor( f1 / binHz ) );
		this.bandCenter[ b ] = Math.sqrt( f0 * f1 ) / binHz;
	}

	this.lowHi = Math.max( 1, Math.floor( 150 / binHz ) );
	this.voxLo = Math.round( 250 / binHz );
	this.voxHi = Math.round( 3500 / binHz );
	this.fluxHi = Math.min( bins - 1, Math.round( 8000 / binHz ) );

	this.spectrum = new Float32Array( NB );
	this.bandMean = new Float32Array( NB );
	this.vox = 0;
	this.voxMean = 0;

	// Envelopes
	this.shortE = this.midE = this.longE = 0;
	this.bassShort = this.bassMid = this.bassLong = 0;
	this.fluxMean = 0;
	this.onsetVar = 1;
	this.history = [];          // { t, o }
	this.prevO = this.prevPrevO = 0;
	this.hits = [];             // { type, s } for the Pulse layer
	this.lead = 0.05;
	this.level = 0;
	this.fastE = 0;
	this.bandsOnset = {
		kick:  { lo: 1, hi: Math.max( 1, Math.floor( 150 / binHz ) ), gap: 0.12 },
		snare: { lo: Math.round( 1200 / binHz ), hi: Math.round( 6000 / binHz ), gap: 0.1 },
		hat:   { lo: Math.round( 6000 / binHz ), hi: Math.min( bins - 1, Math.round( 16000 / binHz ) ), gap: 0.06 }
	};

	for( var bandName in this.bandsOnset ) {

		var bo = this.bandsOnset[ bandName ];
		bo.flux = bo.mean = bo.prev = bo.prevPrev = 0;
		bo.variance = 1;
		bo.last = -1;
	}

	this.primed = false;
	this.soundSince = Infinity;

	// Tempo / beats
	this.period = 0.5;
	this.bpm = 120;
	this.tempoConfidence = 0;
	this.nextTempoAt = 0;
	this.nextBeat = 0;
	this.lastBeat = 0;
	this.lastPeak = -1;
	this.beatCount = 0;
	this.pendingBeats = 0;
	this.lastNow = ctx.currentTime;
	this.startedAt = ctx.currentTime;

	// Clock used by the Director in place of an <audio> element
	var t0 = ctx.currentTime;

	this.clock = {
		get currentTime() { return ctx.currentTime - t0; },
		set currentTime( v ) { t0 = ctx.currentTime - v; },
		play: function() { ctx.resume(); },
		pause: function() {},
		volume: 1,
		paused: false
	};

	this.resetDirector();

	this.running = true;
	( function loop() {

		if( ! self.running )
			return;

		self.tick();
		self.raf = requestAnimationFrame( loop );
	} )();
}

LiveEngine.prototype = {

	dispose: function() {

		this.running = false;
		cancelAnimationFrame( this.raf );
		this.stream.getTracks().forEach( function( t ) { t.stop(); } );

		try {

			this.source.disconnect();
			this.analyser.disconnect();
			this.stereo.disconnect();
			this.splitter.disconnect();
			this.sideL.disconnect();
			this.sideR.disconnect();
			this.sideAnalyser.disconnect();
			this.sink.disconnect();
		}
		catch( e ) {}
	},

	resetDirector: function() {

		this.phaseStartBeat = this.beatCount;
		this.lastBreakBeat = -1000;
		this.sFrom = 15;
		this.stopRequested = false;
		this.endAt = 0;
		this.beatThisTick = false;
	},

	requestStop: function() {

		this.stopRequested = true;
	},

	pushHit: function( hit ) {

		// A clap / snare counts when it lands on a beat (off-beat percussion is left out)
		if( hit.type === 'snare' ) {

			var period = this.period,
				near = Math.min( Math.abs( this.lastNow - this.lastBeat ), Math.abs( this.nextBeat - this.lastNow ) );

			if( this.tempoConfidence < 0.1 || near > period * ON_BEAT )
				return;

			hit.type = 'backbeat';
		}

		if( this.hits.length < 32 )
			this.hits.push( hit );
	},

	takeBeat: function() {

		var had = this.pendingBeats > 0;
		this.pendingBeats = 0;

		return had;
	},

	// ___________________________________________________ Per-frame analysis

	tick: function() {

		var now = this.ctx.currentTime,
			dt = now - this.lastNow;

		if( dt <= 0 )
			return;

		this.lastNow = now;
		dt = Math.min( dt, 0.1 );

		this.analyser.getFloatFrequencyData( this.db );

		var db = this.db, mag = this.mag, logPrev = this.logPrev,
			bins = this.bins, e = 0, eb = 0, fl = 0, vx = 0, k, m, l;

		for( k = 1; k < bins; k++ ) {

			m = db[ k ] > -160 ? Math.pow( 10, db[ k ] / 20 ) : 0;
			mag[ k ] = m;
			e += m * m;

			if( k <= this.lowHi )
				eb += m * m;

			if( k >= this.voxLo && k <= this.voxHi )
				vx += m * m;

			l = Math.log( 1 + 10000 * m );

			if( l > logPrev[ k ] ) {

				var rise = l - logPrev[ k ];

				if( k <= this.fluxHi )
					fl += rise;

				for( var bn in this.bandsOnset ) {

					var bd = this.bandsOnset[ bn ];

					if( k >= bd.lo && k <= bd.hi )
						bd.flux += rise;
				}
			}

			logPrev[ k ] = l;
		}

		// Per-band hits (kick / snare / hi-hat) for the Pulse layer
		for( var name in this.bandsOnset ) {

			var band = this.bandsOnset[ name ];

			band.mean += ( band.flux - band.mean ) * ease( dt, 0.5 );

			var bo2 = Math.max( 0, band.flux - band.mean );

			band.variance += ( bo2 * bo2 - band.variance ) * ease( dt, 5 );
			bo2 /= Math.sqrt( band.variance ) + 1e-9;

			if( band.prev > 2 && band.prev > band.prevPrev && band.prev >= bo2 && now - band.last > band.gap && e > 1e-7 ) {

				this.pushHit( { type: name, s: Math.min( 1.5, band.prev / 4 ) } );
				band.last = now;
			}

			band.prevPrev = band.prev;
			band.prev = bo2;
			band.flux = 0;
		}

		var silent = e < 1e-7;

		this.detectVocal( now, dt, silent );

		// Start the envelopes at the first sound, so the first seconds don't look like a surge
		if( ! this.primed && ! silent ) {

			this.shortE = this.midE = this.longE = e;
			this.bassShort = this.bassMid = this.bassLong = eb;
			this.primed = true;
			this.soundSince = now;
		}

		// Energy envelopes
		this.shortE += ( e - this.shortE ) * ease( dt, 1.5 );
		this.midE += ( e - this.midE ) * ease( dt, 6 );
		this.longE += ( e - this.longE ) * ease( dt, 20 );
		this.bassShort += ( eb - this.bassShort ) * ease( dt, 1.5 );
		this.bassMid += ( eb - this.bassMid ) * ease( dt, 6 );
		this.bassLong += ( eb - this.bassLong ) * ease( dt, 20 );
		this.fastE += ( e - this.fastE ) * ease( dt, 0.15 );
		this.level = this.primed ? Math.max( 0, Math.min( 1, 0.65 + 10 * Math.log10( ( this.fastE + 1e-12 ) / ( this.longE + 1e-12 ) ) / 12 ) ) : 0;

		// Spectrum, auto-gained per band
		for( var b = 0; b < NB; b++ ) {

			var lo = this.bandLo[ b ], hi = this.bandHi[ b ], v;

			if( lo <= hi ) {

				var s = 0;

				for( k = lo; k <= hi; k++ )
					s += mag[ k ] * mag[ k ];

				v = Math.sqrt( s / ( hi - lo + 1 ) );
			}
			else {

				var c = this.bandCenter[ b ], k0 = Math.floor( c ), t = c - k0;
				v = mag[ k0 ] * ( 1 - t ) + mag[ Math.min( bins - 1, k0 + 1 ) ] * t;
			}

			if( ! silent )
				this.bandMean[ b ] += ( v - this.bandMean[ b ] ) * ( this.bandMean[ b ] ? ease( dt, 10 ) : 1 );

			this.spectrum[ b ] = Math.min( 1600000, v / ( this.bandMean[ b ] + 1e-9 ) * ( 110000 - 65000 * b / ( NB - 1 ) ) );
		}

		// Vocal-range volume, same scale as the original baked data
		vx = Math.sqrt( vx );

		if( ! silent )
			this.voxMean += ( vx - this.voxMean ) * ( this.voxMean ? ease( dt, 15 ) : 1 );

		this.vox = vx < this.voxMean * 0.15 ? 0 : Math.min( 1040, 470 * vx / ( this.voxMean + 1e-9 ) );

		// Onset strength
		this.fluxMean += ( fl - this.fluxMean ) * ease( dt, 0.5 );

		var o = Math.max( 0, fl - this.fluxMean );

		this.onsetVar += ( o * o - this.onsetVar ) * ease( dt, 5 );
		o /= Math.sqrt( this.onsetVar ) + 1e-9;

		this.history.push( { t: now, o: o } );

		while( this.history.length && this.history[ 0 ].t < now - 8 )
			this.history.shift();

		// Onset peak (previous frame was a local maximum)
		var peakTime = -1;

		if( this.prevO > 1.5 && this.prevO > this.prevPrevO && this.prevO >= o )
			peakTime = this.prevTime;

		this.prevPrevO = this.prevO;
		this.prevO = o;
		this.prevTime = now;

		if( now >= this.nextTempoAt && now - this.startedAt > 3 ) {

			this.nextTempoAt = now + 0.5;
			this.estimateTempo( now );
		}

		this.trackBeats( now, peakTime, silent );

		if( Smart.mode === 'live' && LIGHTS.Lights.instance.experiencePlaying )
			this.direct();

		this.beatThisTick = false;
	},

	estimateTempo: function( now ) {

		var fs = 60, span = 6, n = span * fs,
			grid = new Float32Array( n ),
			hist = this.history, h = 0, g, L;

		if( ! hist.length || hist[ 0 ].t > now - 3 )
			return;

		for( g = 0; g < n; g++ ) {

			var t = now - span + g / fs;

			while( h + 1 < hist.length && hist[ h + 1 ].t <= t )
				h++;

			grid[ g ] = hist[ h ].t <= t + 0.03 ? hist[ h ].o : 0;
		}

		var minLag = 18, maxLag = 72,  // 200 .. 50 BPM
			r = new Float32Array( 2 * maxLag + 2 ),
			best = -Infinity, bestL = 30,
			center = this.tempoConfidence > 0.1 ? this.period * fs : 30,
			width = this.tempoConfidence > 0.1 ? 0.5 : 1.0;

		for( L = 0; L < r.length; L++ ) {

			var s = 0;

			for( g = 0; g + L < n; g++ )
				s += grid[ g ] * grid[ g + L ];

			r[ L ] = s / ( n - L );
		}

		for( L = minLag; L <= maxLag; L++ ) {

			var w = Math.exp( -0.5 * Math.pow( Math.log2( L / center ) / width, 2 ) ),
				score = w * ( r[ L ] + 0.5 * r[ 2 * L ] );

			if( score > best ) {

				best = score;
				bestL = L;
			}
		}

		var a = r[ bestL - 1 ], b = r[ bestL ], c = r[ bestL + 1 ],
			den = a - 2 * b + c,
			delta = den ? 0.5 * ( a - c ) / den : 0,
			period = ( bestL + ( Math.abs( delta ) < 1 ? delta : 0 ) ) / fs,
			confidence = r[ 0 ] > 0 ? b / r[ 0 ] : 0;

		if( confidence < 0.05 )
			return;

		this.period = this.tempoConfidence > 0.1 ? this.period + ( period - this.period ) * 0.25 : period;
		this.tempoConfidence += ( confidence - this.tempoConfidence ) * 0.3;
		this.bpm = 60 / this.period;

		// A lasting tempo change (> 6 % for 2 s) starts a new phase
		if( ! this.bpmRef )
			this.bpmRef = this.bpm;

		if( Math.abs( Math.log( this.bpm / this.bpmRef ) ) > Math.log( 1.06 ) ) {

			if( ! this.tempoDevSince )
				this.tempoDevSince = now;
			else if( now - this.tempoDevSince > 2 ) {

				this.tempoChangePending = now;
				this.bpmRef = this.bpm;
				this.tempoDevSince = 0;
			}
		}
		else {

			this.tempoDevSince = 0;
			this.bpmRef += ( this.bpm - this.bpmRef ) * 0.02;
		}
	},

	// Phase-locked beat clock: predicted beats, nudged towards detected onsets
	trackBeats: function( now, peakTime, silent ) {

		var period = this.period;

		if( peakTime >= 0 ) {

			if( this.tempoConfidence < 0.1 ) {

				// No tempo yet: beats on strong onsets
				if( peakTime - this.lastBeat > 0.3 )
					this.fireBeat( peakTime, silent );

				this.nextBeat = peakTime + period;
			}
			else {

				var target = Math.abs( peakTime - this.nextBeat ) < Math.abs( peakTime - this.lastBeat ) ? this.nextBeat : this.lastBeat,
					error = peakTime - target;

				if( Math.abs( error ) < period * 0.25 )
					this.nextBeat += error * 0.2;
			}
		}

		if( this.tempoConfidence < 0.1 )
			return;

		if( now - this.nextBeat > period )
			this.nextBeat = now + period * 0.5;

		// Predicted beats fire a little early to make up for capture and display delay
		while( now + this.lead >= this.nextBeat ) {

			this.fireBeat( this.nextBeat, silent );
			this.nextBeat += period;
		}
	},

	fireBeat: function( time, silent ) {

		this.lastBeat = time;
		this.beatCount++;
		this.beatThisTick = true;

		if( ! silent && LIGHTS.Music.phase.index !== 16 ) {

			this.pendingBeats++;
			this.pushHit( { type: 'beat', s: 0.8, down: this.beatCount % 4 === 0 } );
		}

		UI.pulse();
	},

	// ___________________________________________________ Live director

	direct: function() {

		var phase = LIGHTS.Music.phase,
			index = phase.index,
			time = LIGHTS.time;

		if( this.endAt )
			return;

		if( this.stopRequested ) {

			this.jump( 22 );
			this.endAt = time + 9;
			phase.times[ 22 ] = this.endAt;
			return;
		}

		if( ! this.beatThisTick )
			return;

		var hasSound = this.shortE > 1e-7;

		// Intro: ends when the singer comes in (or is already singing), on a clear energy jump,
		// or after 12 s at the latest
		if( index === 0 ) {

			if( time > 2 && ( this.vocalEntryPending || this.vocalOn ) ) {

				this.vocalEntryPending = 0;
				this.jump( 1, 'vocal' );
			}
			else if( hasSound && ( time > 12 || ( time > 4 && this.shortE > 1.6 * this.midE ) ) ) {

				this.jump( 1 );
			}

			return;
		}

		var beatsIn = this.beatCount - this.phaseStartBeat;

		if( beatsIn === 0 || beatsIn % 4 !== 0 )
			return;

		var bars = beatsIn / 4,
			L = PHASE_BARS[ index ],
			ratio = this.shortE / ( this.longE + 1e-12 ),
			isBreak = ratio < 0.45 || this.bassShort < 0.25 * this.bassLong,
			settled = this.lastNow - this.soundSince > 16,
			surge = settled && ratio > 1.3 && this.bassShort > 0.6 * this.bassLong,
			novelty = Math.abs( Math.log( ( this.shortE + 1e-12 ) / ( this.midE + 1e-12 ) ) ) +
					  0.5 * Math.abs( Math.log( ( this.bassShort + 1e-12 ) / ( this.bassMid + 1e-12 ) ) );

		// Forget cues older than ~8 s
		if( this.vocalEntryPending && this.lastNow - this.vocalEntryPending > 8 ) this.vocalEntryPending = 0;
		if( this.tempoChangePending && this.lastNow - this.tempoChangePending > 8 ) this.tempoChangePending = 0;

		// The singer comes in, or the tempo changes: start the next phase on this bar
		var cue = this.vocalEntryPending ? 'vocal' : this.tempoChangePending ? 'tempo' : '';

		if( cue && index !== 16 && bars >= 2 ) {

			this.vocalEntryPending = this.tempoChangePending = 0;

			if( index === 15 || index === 21 )
				this.jump( 17, cue );
			else if( index === 18 )
				this.jump( this.sFrom === 21 ? 7 : 19, cue );
			else
				this.jump( index + 1, cue );

			return;
		}

		// Break: hold until the music comes back, then "drop" into the big chorus
		if( index === 16 ) {

			if( ! isBreak || bars >= 4 )
				this.jump( 17 );

			return;
		}

		if( index >= 3 && settled && isBreak && this.beatCount - this.lastBreakBeat > 32 ) {

			this.enterBreak( index );
			return;
		}

		// Verse that suddenly gets big: jump straight to the next chorus
		if( surge && bars >= 2 ) {

			if( index === 1 || index === 2 ) { this.jump( 3 ); return; }
			if( index >= 7 && index <= 10 ) { this.jump( 11 ); return; }
		}

		if( ( bars >= L && ( novelty > 0.25 || bars >= Math.ceil( L * 1.5 ) ) ) ||
			( bars >= Math.max( 2, L / 2 ) && novelty > 0.6 ) ) {

			if( index === 15 || index === 21 )
				this.enterBreak( index );
			else if( index === 18 )
				this.jump( this.sFrom === 21 ? 7 : 19 );
			else
				this.jump( index + 1 );
		}
	},

	// Live lead-vocal detection: centre-panned voice-range energy well above its running level,
	// with the sliding / wobbling pitch of a voice. Entry = singing again after >= 2.5 s.
	detectVocal: function( now, dt, silent ) {

		var sideDb = this.sideDb, mag = this.mag, centred = this.centred, k, cv = 0;

		this.sideAnalyser.getFloatFrequencyData( sideDb );

		for( k = 1; k <= this.pitchHi; k++ ) {

			var ms = sideDb[ k ] > -160 ? Math.pow( 10, sideDb[ k ] / 20 ) : 0,
				c = Math.max( 0, mag[ k ] - ms );

			centred[ k ] = c;

			if( k >= this.voxLo && k <= this.voxHi )
				cv += c * c;
		}

		var bestSal = 0, bestPc = 0, pc;

		for( pc = 0; pc < this.pitchBins.length; pc++ ) {

			var sal = 0, hw = 1;

			for( var h = 1; h <= 6; h++, hw *= 0.8 ) {

				var kk = this.pitchBins[ pc ] * h, k0 = Math.floor( kk ), kt = kk - k0;

				if( k0 + 1 > this.pitchHi )
					break;

				sal += ( centred[ k0 ] * ( 1 - kt ) + centred[ k0 + 1 ] * kt ) * hw;
			}

			if( sal > bestSal ) {

				bestSal = sal;
				bestPc = pc;
			}
		}

		if( silent )
			return;

		var pitched = bestSal > 0.5 * this.salMean,
			step = Math.abs( bestPc - this.prevPitch );

		this.prevPitch = bestPc;
		this.salMean += ( bestSal - this.salMean ) * ( this.salMean ? ease( dt, 10 ) : 1 );
		this.microE += ( ( pitched && step > 0 && step <= 3 ? 1 : 0 ) - this.microE ) * ease( dt, 1 );
		this.pitchedE += ( ( pitched ? 1 : 0 ) - this.pitchedE ) * ease( dt, 1 );

		var level = Math.log( 1e-9 + Math.sqrt( cv ) );

		this.vocalMean += ( level - this.vocalMean ) * ( this.vocalMean ? ease( dt, 15 ) : 1 );
		this.vocalVar += ( ( level - this.vocalMean ) * ( level - this.vocalMean ) - this.vocalVar ) * ease( dt, 15 );

		var z = ( level - this.vocalMean ) / ( Math.sqrt( this.vocalVar ) + 1e-6 ),
			cue = this.pitchedE > 0.3 ? this.microE / this.pitchedE : 0,
			active = now - this.startedAt > 5 && z > 0.2 && cue > 0.1;

		if( active ) {

			this.vocalQuietSince = -1;

			if( this.vocalActiveSince < 0 )
				this.vocalActiveSince = now;

			if( ! this.vocalOn && now - this.vocalActiveSince > 0.3 ) {

				this.vocalOn = true;

				if( now - this.vocalOffAt >= 2.5 ) {

					this.vocalEntryPending = now;
					this.pushHit( { type: 'voice', s: 1 } );
				}
			}
		}
		else {

			this.vocalActiveSince = -1;

			if( this.vocalQuietSince < 0 )
				this.vocalQuietSince = now;

			if( this.vocalOn && now - this.vocalQuietSince > 0.4 ) {

				this.vocalOn = false;
				this.vocalOffAt = now;
			}
		}
	},

	enterBreak: function( from ) {

		this.sFrom = from;
		this.lastBreakBeat = this.beatCount;
		this.jump( 16 );
	},

	jump: function( target, reason ) {

		var times = LIGHTS.Music.phase.times;

		this.lastReason = reason || '';

		for( var i = 0; i < times.length; i++ )
			times[ i ] = Infinity;

		LIGHTS.Music.phase.index = target - 1;
		times[ target - 1 ] = -1;
		this.phaseStartBeat = this.beatCount;
	}
};

function ease( dt, tau ) {

	return 1 - Math.exp( -dt / tau );
}

// _______________________________________________________________________________________________ Pulse

// Hit-level sync layer: every beat, kick, snare, hi-hat and accent of the song gets a visible
// reaction (camera punch and surge, sky and ground flashes, star sparkles, sparkler pump),
// in every phase. Uploaded files use the hits found by the analyzer, live audio the live engine.

var DOT_BEAT_PHASES = { 15: 1, 17: 1, 18: 1, 19: 1, 20: 1 },                 // phases whose own beat leaves the dots idle
	DOT_KICK_PHASES = { 1: 1, 2: 1, 3: 1, 4: 1, 11: 1, 12: 1, 15: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1 },
	DOT_FLASH_PHASES = { 1: 1, 2: 1, 3: 1, 4: 1, 11: 1, 12: 1, 17: 1, 18: 1, 19: 1, 20: 1, 21: 1 },
	ON_BEAT = 0.12;    // how far (in beats) a hit may sit from the beat and still count as on it

var Pulse = Smart.pulse = {

	active:     false,
	events:     [],
	index:      0,
	kick:       0,
	snare:      0,
	accent:     0,
	level:      0,
	hatFlash:   0,
	hatKey:     0,
	voice:      0,
	starBurst:  0,
	hue:        0,
	down:       0,
	beatIndex:  0,
	lastT:      0,
	lastNow:    0,
	lastFat:    -10,

	// Merge the analyzer's hit lists into one time-sorted event list
	build: function( track ) {

		var events = [],
			beats = track.beats,
			S = track.phaseTimes[ 15 ], E = track.phaseTimes[ 16 ],
			i, t;

		function strongest( list, t, window ) {

			var lo = 0, hi = list.length / 2 - 1, best = 0, j;

			while( lo < hi ) {

				var m = ( lo + hi ) >> 1;

				if( list[ m * 2 ] < t - window ) lo = m + 1;
				else hi = m;
			}

			for( j = lo; j * 2 < list.length && list[ j * 2 ] <= t + window; j++ )
				best = Math.max( best, list[ j * 2 + 1 ] );

			return best;
		}

		function levelAt( t ) {

			return track.level[ Math.max( 0, Math.min( track.level.length - 1, Math.round( t * 60 ) ) ) ];
		}

		for( i = 0; i < beats.length; i++ ) {

			t = beats[ i ];

			if( levelAt( t ) < 0.06 || ( t >= S - 0.05 && t < E - 0.05 ) )
				continue;

			events.push( {
				t:    t,
				type: 'beat',
				s:    Math.max( 0.35, Math.min( 1.3, Math.max( strongest( track.kicks, t, 0.07 ), strongest( track.snares, t, 0.07 ) ) ) ),
				down: ( ( i - track.downbeat ) % 4 + 4 ) % 4 === 0,
				index: i
			} );
		}

		// Position of a time on the beat grid: beat index and offset in beats
		function onGrid( tt ) {

			var lo = 0, hi = beats.length - 1;

			while( hi - lo > 1 ) {

				var m = ( lo + hi ) >> 1;

				if( beats[ m ] <= tt ) lo = m;
				else hi = m;
			}

			var j = Math.abs( beats[ hi ] - tt ) < Math.abs( beats[ lo ] - tt ) ? hi : lo,
				span = beats[ Math.min( beats.length - 1, j + 1 ) ] - beats[ Math.max( 0, j - 1 ) ] || 1;

			return { index: j, offset: ( tt - beats[ j ] ) / ( span / 2 ) };
		}

		// Claps / snares that sit on beats 2 and 4
		for( i = 0; i < track.snares.length; i += 2 ) {

			var g = onGrid( track.snares[ i ] ),
				pos = ( ( g.index - track.downbeat ) % 4 + 4 ) % 4;

			if( track.snares[ i + 1 ] >= 0.5 && Math.abs( g.offset ) <= ON_BEAT && ( pos === 1 || pos === 3 ) )
				events.push( { t: beats[ g.index ], type: 'backbeat', s: track.snares[ i + 1 ] } );
		}

		// Hi-hats on the beats and half-beats only, snapped to them (dense, irregular hats made
		// the stars flicker between the beats)
		var lastHat = -1;

		for( i = 0; i < track.hats.length; i += 2 ) {

			var gh = onGrid( track.hats[ i ] ),
				span = ( beats[ Math.min( beats.length - 1, gh.index + 1 ) ] - beats[ gh.index ] ) || track.beatPeriod,
				halfOff = ( track.hats[ i ] - beats[ gh.index ] ) / span,
				slot = Math.abs( halfOff ) <= ON_BEAT ? 0 : Math.abs( halfOff - 0.5 ) <= ON_BEAT ? 0.5 : -1,
				at = beats[ gh.index ] + slot * span;

			if( track.hats[ i + 1 ] < 0.45 || slot < 0 || at <= lastHat + 0.01 )
				continue;

			lastHat = at;
			events.push( { t: at, type: 'hat', s: track.hats[ i + 1 ] } );
		}

		// Accents that land on a beat (snapped to it)
		for( i = 0; i < track.accents.length; i += 2 ) {

			var ga = onGrid( track.accents[ i ] );

			if( Math.abs( ga.offset ) <= ON_BEAT )
				events.push( { t: beats[ ga.index ], type: 'accent', s: track.accents[ i + 1 ] } );
		}

		for( i = 0; i < track.impacts.length; i += 2 )
			events.push( { t: track.impacts[ i ], type: 'impact', s: track.impacts[ i + 1 ] } );

		// The singer comes in: the voice's sparkler flares
		for( i = 0; i < track.vocalEvents.length; i++ )
			if( track.vocalEvents[ i ].kind === 'vocal' )
				events.push( { t: track.vocalEvents[ i ].t, type: 'voice', s: track.vocalEvents[ i ].s } );

		events.sort( function( a, b ) { return a.t - b.t; } );
		this.events = events;
	},

	start: function() {

		this.active = Smart.mode === 'file' || Smart.mode === 'live';
		this.kick = this.snare = this.accent = this.down = this.hatFlash = this.voice = this.starBurst = 0;
		this.lastNow = performance.now();
		this.lastT = Smart.clockTime() + Smart.lead();
		this.index = this.find( this.lastT );
		this.lastFat = -10;

		if( Smart.mode === 'live' )
			Smart.live.hits.length = 0;
	},

	stop: function() {

		this.active = false;
		UI.flash( 0 );
	},

	find: function( t ) {

		var events = this.events, lo = 0, hi = events.length;

		while( lo < hi ) {

			var m = ( lo + hi ) >> 1;

			if( events[ m ].t < t ) lo = m + 1;
			else hi = m;
		}

		return lo;
	},

	// Before the Director's update: advance envelopes, fire due events
	update: function() {

		if( ! this.active )
			return;

		var now = performance.now(),
			dt = Math.min( 0.1, Math.max( 0, ( now - this.lastNow ) / 1000 ) ),
			t = Smart.clockTime() + Smart.lead();

		this.lastNow = now;
		this.kick *= Math.exp( -dt / 0.12 );
		this.down *= Math.exp( -dt / 0.25 );
		this.snare *= Math.exp( -dt / 0.1 );
		this.accent *= Math.exp( -dt / 0.3 );
		this.voice *= Math.exp( -dt / 0.8 );

		if( Smart.mode === 'file' ) {

			var events = this.events;

			// Seek / stall: jump without replaying
			if( t < this.lastT - 0.3 || t > this.lastT + 1 )
				this.index = this.find( t );

			while( this.index < events.length && events[ this.index ].t <= t ) {

				var e = events[ this.index++ ];

				if( t - e.t < 0.15 )
					this.fire( e, t );
			}

			var lv = Smart.track.level[ Math.max( 0, Math.min( Smart.track.level.length - 1, Math.floor( t * 60 ) ) ) ] || 0;
			this.level += ( lv - this.level ) * Math.min( 1, dt * 12 );

			Smart.applyLead();
		}
		else if( Smart.mode === 'live' ) {

			var hits = Smart.live.hits;

			while( hits.length )
				this.fire( hits.shift(), t );

			this.level += ( Smart.live.level - this.level ) * Math.min( 1, dt * 8 );
		}

		this.lastT = t;
	},

	fire: function( e, t ) {

		var director = LIGHTS.Lights.instance.director,
			tiles = director.tileManager,
			dots = tiles.terrainDots,
			phase = LIGHTS.Music.phase.index,
			intense = 0.4 + 0.6 * this.level,
			s = e.s;

		if( phase >= 23 )
			return;

		// Hi-hats: the stars, nothing else
		if( e.type === 'hat' ) {

			this.hatFlash = Math.max( this.hatFlash, Math.min( 1, s ) );
			this.hatKey = ( this.hatKey + 1 ) % 5;
			return;
		}

		// The break holds still; the intro only breathes
		if( phase === 16 )
			return;

		if( phase === 0 )
			s *= 0.4;

		switch( e.type ) {

			// Every beat: one instant hit (camera punch + dip, sky and spotlight pulse), stronger on the bar
			case 'beat':
				s = Math.min( 1, s ) * ( e.down ? 1.3 : 1 );
				this.kick = Math.max( this.kick, ( 0.5 + 0.5 * s ) * ( 0.6 + 0.4 * intense ) );
				this.beatIndex = e.index;

				if( e.down ) {

					this.down = Math.max( this.down, 0.6 + 0.4 * intense );
					this.hue = ( this.hue + 1 ) % LIGHTS.colors.length;
				}

				if( dots.active && DOT_BEAT_PHASES[ phase ] )
					dots.paintCircles( Math.round( ( e.down ? 10 : 5 ) + 8 * s * intense ) );

				UI.pulse();
				break;

			// Clap / snare on beats 2 and 4: white sparks on the ground
			case 'backbeat':
				this.snare = Math.max( this.snare, Math.min( 1, s ) );

				if( dots.active && DOT_KICK_PHASES[ phase ] )
					dots.paintCircles( Math.round( 2 + 4 * s * intense ), true );
				break;

			// Accent on a beat: balls inflate / deflate, light flash
			case 'accent':
				this.accent = Math.max( this.accent, 0.6 * s );

				if( phase >= 3 && t - this.lastFat > 1.5 ) {

					tiles.balls.changeFat();
					this.lastFat = t;
				}
				break;

			case 'voice':
				this.voice = Math.max( this.voice, s );
				this.starBurst = Math.max( this.starBurst, s );
				this.accent = Math.max( this.accent, 0.45 * s );
				break;

			// Drops, chorus entries, the return after a break
			case 'impact':
				this.accent = Math.max( this.accent, Math.min( 1.2, s ) );
				this.kick = 1;
				this.down = 1;

				if( dots.active && DOT_FLASH_PHASES[ phase ] )
					dots.paintAll( 1, true );
				break;
		}
	},

	// After the Director's update: the light flash (bars, accents and drops only)
	render: function() {

		if( ! this.active )
			return;

		var phase = LIGHTS.Music.phase.index,
			calm = phase === 0 || phase === 16 ? 0.3 : 1,
			opacity = calm * Math.min( 0.4, 0.3 * this.accent + 0.08 * this.down * this.level );

		UI.flash( opacity, LIGHTS.colors[ this.hue ] );
	}
};


// _______________________________________________________________________________________________ Shows

// Every song follows the same outline (intro, verse, chorus, verse, chorus, bridge, break,
// chorus, bridge, outro) at the times the analysis found. A "show" decides which look each
// part gets: the three chorus scenes in any order and the two bridge scenes either way round
// (12 shows), plus its own camera heights / angles / zoom and sky colour. Each song gets its
// own show; REMIX steps through the others.

var CHORUS_SCENES = { C1: [ 3, 4, 5, 6 ], C2: [ 11, 12, 13, 14 ], C3: [ 17, 18, 19, 20 ] },
	BRIDGE_SCENES = { D1: [ 15 ], D2: [ 21 ] },
	SCENE_OF = [ 'A1', 'B1', 'B1', 'C1', 'C1', 'C1', 'C1', 'B2', 'B2', 'B2', 'B2', 'C2', 'C2', 'C2', 'C2', 'D1', 'S', 'C3', 'C3', 'C3', 'C3', 'D2', 'A2', 'END' ],
	SHOWS = [];

[ [ 'C1', 'C2', 'C3' ], [ 'C2', 'C1', 'C3' ], [ 'C3', 'C1', 'C2' ], [ 'C1', 'C3', 'C2' ], [ 'C2', 'C3', 'C1' ], [ 'C3', 'C2', 'C1' ] ].forEach( function( chorus ) {

	[ [ 'D1', 'D2' ], [ 'D2', 'D1' ] ].forEach( function( bridge ) {

		SHOWS.push( { chorus: chorus, bridge: bridge } );
	} );
} );

function hashString( text ) {

	var h = 5381;

	for( var i = 0; i < text.length; i++ )
		h = ( ( h << 5 ) + h + text.charCodeAt( i ) ) | 0;

	return h >>> 0;
}

function random( seed ) {

	// mulberry32
	var t = ( seed + 0x6D2B79F5 ) | 0;

	t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
	t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );

	return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;
}

var Show = Smart.show = {

	index:      0,
	songKey:    0,
	program:    null,
	slot:       1,
	active:     false,
	fx:         { wordsUntil: 0, restoreUntil: 0, dotsAfterWords: false },

	// Pick the song's own show (or the one chosen with REMIX last time)
	choose: function( track, title ) {

		this.songKey = hashString( title + '|' + Math.round( track.duration * 10 ) );

		var saved = null;

		try {

			saved = localStorage.getItem( 'lightsSmartShow' + this.songKey );
		}
		catch( e ) {}

		this.setIndex( saved !== null && saved !== '' ? parseInt( saved, 10 ) : this.songKey % SHOWS.length );
	},

	setIndex: function( index ) {

		var show = SHOWS[ ( ( index % SHOWS.length ) + SHOWS.length ) % SHOWS.length ];

		this.index = SHOWS.indexOf( show );
		this.program = [ 0, 1, 2 ]
			.concat( CHORUS_SCENES[ show.chorus[ 0 ] ], [ 7, 8, 9, 10 ], CHORUS_SCENES[ show.chorus[ 1 ] ],
				BRIDGE_SCENES[ show.bridge[ 0 ] ], [ 16 ], CHORUS_SCENES[ show.chorus[ 2 ] ], BRIDGE_SCENES[ show.bridge[ 1 ] ], [ 22 ] );
		this.seed = ( this.songKey ^ Math.imul( this.index + 1, 2654435761 ) ) >>> 0;
	},

	remix: function() {

		this.setIndex( this.index + 1 );

		try {

			localStorage.setItem( 'lightsSmartShow' + this.songKey, String( this.index ) );
		}
		catch( e ) {}
	},

	describe: function() {

		var show = SHOWS[ this.index ],
			names = { C1: 'light trails', C2: 'avatars', C3: 'spotlights', D1: 'waves', D2: 'pulse' };

		return 'Show ' + ( this.index + 1 ) + ' of ' + SHOWS.length + ': choruses ' +
			show.chorus.map( function( c ) { return names[ c ]; } ).join( ' → ' ) + ', bridges ' +
			show.bridge.map( function( b ) { return names[ b ]; } ).join( ' → ' );
	},

	// Per-phase camera variation and the show's sky colour
	camera: function( phase ) {

		if( ! this.active || phase < 1 || phase > 22 )
			return null;

		var base = this.seed + phase * 977;

		return {
			alt:  0.85 + 0.45 * random( base ),
			tilt: ( random( base + 1 ) - 0.4 ) * 0.12,
			fov:  ( random( base + 2 ) - 0.35 ) * 10
		};
	},

	skyHue: function() {

		return this.active ? ( random( this.seed + 31 ) - 0.5 ) * 0.5 : 0;
	},

	start: function() {

		this.active = Smart.mode === 'file' && !! this.program;
		this.slot = 1;
		this.fx.wordsUntil = this.fx.restoreUntil = 0;
		this.fx.dotsAfterWords = false;

		if( this.active )
			this.fillTimes();
	},

	fillTimes: function() {

		var times = LIGHTS.Music.phase.times;

		for( var i = 0; i < times.length; i++ )
			times[ i ] = Infinity;

		// The cannons fade out 2 s before the end
		times[ 22 ] = Smart.track.phaseTimes[ 22 ] - Smart.appliedLead;
	},

	// Before the Director's update: launch the scene whose time has come
	update: function() {

		if( ! this.active )
			return;

		var phaseTimes = Smart.track.phaseTimes,
			now = Smart.clockTime() + Smart.appliedLead,
			slot = this.slot,
			due = -1;

		// Seeking back: restart from the right slot
		if( slot > 1 && now < phaseTimes[ slot - 2 ] - 0.5 ) {

			slot = 1;

			while( slot <= 22 && now >= phaseTimes[ slot - 1 ] )
				slot++;

			due = slot - 1;
		}

		while( slot <= 22 && now >= phaseTimes[ slot - 1 ] ) {

			due = slot;
			slot++;
		}

		this.slot = slot;

		// (seeking back into the intro keeps the current scene until the first part starts)
		if( due >= 1 )
			this.jump( this.program[ due ] );

		// The end of the song
		if( slot > 22 && now >= phaseTimes[ 22 ] && LIGHTS.Music.phase.index === 22 )
			LIGHTS.Music.phase.times[ 22 ] = -1;
	},

	jump: function( phase ) {

		var current = LIGHTS.Music.phase.index;

		if( phase === current )
			return;

		if( SCENE_OF[ current ] !== SCENE_OF[ phase ] )
			Transitions.apply( SCENE_OF[ current ], SCENE_OF[ phase ] );

		this.fillTimes();
		LIGHTS.Music.phase.index = phase - 1;
		LIGHTS.Music.phase.times[ phase - 1 ] = -1;
	}
};

// Clean hand-overs when scenes play in a different order than the original. Each scene sets
// itself up, but a few leave something behind for the scene that originally followed them.
var Transitions = {

	apply: function( from, to ) {

		var director = LIGHTS.Lights.instance.director,
			tiles = director.tileManager,
			mesh = tiles.terrainMesh,
			fx = Show.fx;

		// Chorus 1 ends with words floating in the air; verse 2 normally explodes them
		if( from === 'C1' && to !== 'B2' )
			fx.wordsUntil = LIGHTS.time + 1.5;

		// The break flattens the ground and blacks out the terrain; the spotlight chorus normally restores them
		if( from === 'S' && to !== 'C3' ) {

			mesh.material.color.setHex( 0xFFFFFF );
			mesh.smartColor = { r: 1, g: 1, b: 1 };
			mesh.material.reflectivity = 0.2;
			director.terrain.displacement.launchFlat2Terrain();
			fx.restoreUntil = LIGHTS.time + 4;
		}

		// Spotlights belong to the big choruses and bridges
		if( tiles.cannons.active && { B1: 1, B2: 1, C1: 1, C2: 1 }[ to ] ) {

			tiles.cannons.active = false;
			tiles.apply();
		}

		// Spotlight chorus and bridges expect the ground dots switched on and lying on the terrain
		if( { C3: 1, D1: 1, D2: 1 }[ to ] ) {

			if( fx.wordsUntil )
				fx.dotsAfterWords = true;
			else
				this.groundDots();
		}
	},

	groundDots: function() {

		var tiles = LIGHTS.Lights.instance.director.tileManager,
			dots = tiles.terrainDots;

		if( dots.geometry.vertices !== dots.terrainVertices ) {

			dots.resetDots();
			dots.geometry.vertices = dots.terrainVertices;
			dots.dirtyVertices = true;
		}

		if( ! dots.active ) {

			dots.active = true;
			tiles.apply();
		}
	}
};

// _______________________________________________________________________________________________ Groove

// The song's beat and bar position, for the motions that follow the music: spotlights jump
// to a new position on every beat, ground circles are born on the bars, words float and the
// sky changes colour over whole bars. (Element animation speeds are left alone: speeding them
// up and down with the beat made gliding motions wobble and look late.)

var Groove = Smart.groove = {

	active:      false,
	beatPos:     0,     // beats since the first downbeat (fractional)
	bar:         0,     // bars since the first downbeat (fractional)
	musicalTime: 0,     // the song's position as if it were 120 BPM (0.5 s per beat)
	downbeat:    false, // a new bar started this frame
	beat:        false, // a new beat started this frame
	beatIndex:   0,

	start: function() {

		this.active = Smart.mode === 'file' || Smart.mode === 'live';
		this.lastBar = this.lastBeat = -Infinity;
		this.pointer = 0;
		this.update();
		this.downbeat = this.beat = false;
	},

	stop: function() {

		this.active = false;
	},

	update: function() {

		if( ! this.active )
			return;

		var period;

		if( Smart.mode === 'file' ) {

			var beats = Smart.track.beats,
				t = Smart.clockTime() + Smart.appliedLead,
				i = this.pointer || 0;

			period = Smart.track.beatPeriod;

			if( i >= beats.length || beats[ i ] > t )
				i = 0;

			while( i + 1 < beats.length && beats[ i + 1 ] <= t )
				i++;

			this.pointer = i;

			if( t < beats[ 0 ] )
				this.beatPos = ( t - beats[ 0 ] ) / period;
			else if( i + 1 >= beats.length )
				this.beatPos = i + ( t - beats[ i ] ) / period;
			else
				this.beatPos = i + ( t - beats[ i ] ) / ( beats[ i + 1 ] - beats[ i ] );

			this.beatPos -= Smart.track.downbeat;
		}
		else {

			var live = Smart.live;

			period = live.period;
			this.beatPos = live.beatCount - 1 + Math.max( 0, Math.min( 0.999, ( live.lastNow + live.lead - live.lastBeat ) / period ) );
		}

		this.period = period;
		this.bar = this.beatPos / 4;
		this.beatIndex = Math.floor( this.beatPos );
		this.musicalTime = this.beatPos * 0.5;
		this.downbeat = Math.floor( this.bar ) > this.lastBar && this.lastBar !== -Infinity;
		this.beat = this.beatIndex > this.lastBeat && this.lastBeat !== -Infinity;
		this.lastBar = Math.floor( this.bar );
		this.lastBeat = this.beatIndex;
	}
};

// Run a method with LIGHTS.time swapped for the song's musical time (bar-locked periodic motion)
function onMusicalTime( proto, name ) {

	var original = proto[ name ];

	proto[ name ] = function() {

		if( ! Groove.active )
			return original.apply( this, arguments );

		var time = LIGHTS.time;

		LIGHTS.time = Groove.musicalTime;

		try {

			return original.apply( this, arguments );
		}
		finally {

			LIGHTS.time = time;
		}
	};
}

// _______________________________________________________________________________________________ Patches

// Loader: images & font load right away, the music is chosen by the user
LIGHTS.Loader.prototype.loadMusic = function() {

	LIGHTS.tweets = [];
	this.loadAvatarImages( [] );
};

// Words written with dots on the terrain (originally Twitter handles)
LIGHTS.Config.defaultTweets = [ 'LIGHTS', 'MUSIC', 'RHYTHM', 'BASS', 'VOICE', 'BEAT', 'GLOW', 'FEEL', 'DANCE' ];

var wordInit = LIGHTS.TerrainDotsWord.prototype.initialize;

LIGHTS.TerrainDotsWord.prototype.initialize = function( word, position ) {

	wordInit.call( this, word.replace( /^@/, '' ), position );
};

// App: wait for a song before showing PLAY
LIGHTS.Lights.prototype.launch = function() {

	var home = this.home;

	LIGHTS.stopwatch = new LIGHTS.Stopwatch();

	this.view = new LIGHTS.View( this.renderManager );
	this.director = new LIGHTS.Director( this.view );

	applyVisualIdentity();
	UI.loaded();

	Smart.whenReady( function() {

		home.launchPlay();
	} );
};

var playExperience = LIGHTS.Lights.prototype.playExperience,
	playHome = LIGHTS.Lights.prototype.playHome;

LIGHTS.Lights.prototype.playExperience = function() {

	// Home keeps calling this while its closing animation is done; start once a song is ready
	if( ! Smart.ready || this.experiencePlaying )
		return;

	if( Smart.ctx )
		Smart.ctx.resume();

	UI.onPlay();
	playExperience.call( this );
};

LIGHTS.Lights.prototype.playHome = function() {

	playHome.call( this );
	UI.onHome();
};

// Director: per-song phase times, live clock
var directorStart = LIGHTS.Director.prototype.start;

LIGHTS.Director.prototype.start = function() {

	var times = LIGHTS.Music.phase.times, i;

	this.music = LIGHTS.musicAudio;

	if( Smart.mode === 'file' ) {

		Smart.applyLead( true );
		Show.start();
	}
	else if( Smart.mode === 'live' ) {

		for( i = 0; i < times.length; i++ )
			times[ i ] = Infinity;

		Smart.live.resetDirector();
	}
	else {

		for( i = 0; i < times.length; i++ )
			times[ i ] = Smart.originalTimes[ i ];
	}

	directorStart.call( this );
	Pulse.start();
	Groove.start();

	// If the browser blocks playback (autoplay policy), resume on the next click or key press
	var music = this.music,
		app = LIGHTS.Lights.instance;

	if( window.HTMLMediaElement && music instanceof HTMLMediaElement ) {

		var attempt = music.play();

		if( attempt && attempt.catch ) {

			attempt.catch( function( err ) {

				console.warn( 'Lights: playback did not start', err && err.name, err && err.message );

				if( ! app.experiencePlaying || ! music.paused )
					return;

				UI.toast( 'Click anywhere to start the sound' );

				var retry = function() {

					window.removeEventListener( 'pointerdown', retry, true );
					window.removeEventListener( 'keydown', retry, true );

					if( music.paused && app.experiencePlaying )
						music.play();
				};

				window.addEventListener( 'pointerdown', retry, true );
				window.addEventListener( 'keydown', retry, true );
			} );
		}
	}
};

var directorUpdate = LIGHTS.Director.prototype.update;

LIGHTS.Director.prototype.update = function() {

	Show.update();
	Pulse.update();
	Groove.update();
	directorUpdate.call( this );
	Pulse.render();
};

var directorStop = LIGHTS.Director.prototype.stop;

LIGHTS.Director.prototype.stop = function() {

	Pulse.stop();
	Groove.stop();
	Show.active = false;
	directorStop.call( this );
};

// Camera: an instant zoom punch and dip on every beat (no gliding moves, they read as late),
// and a cruising speed that follows how loud the song is
var playerUpdate = LIGHTS.Player.prototype.update;

LIGHTS.Player.prototype.update = function( immediate ) {

	var active = Pulse.active && immediate === undefined,
		dip = 0;

	if( active ) {

		var base = 0.8 + 0.35 * Pulse.level;

		this.turbo += ( base - 1 ) * LIGHTS.deltaTime * 2;
		dip = -3 * Pulse.kick - 5 * Math.min( 1, Pulse.accent );
		this.altitude += dip;
	}

	playerUpdate.apply( this, arguments );

	if( active )
		this.altitude -= dip;

	if( active && this.isCamera ) {

		var fov = this.fov * ( 1 - 0.055 * Pulse.kick - 0.03 * Pulse.down - 0.08 * Math.min( 1, Pulse.accent ) );

		if( Math.abs( this.camera.fov - fov ) > 0.001 ) {

			this.camera.fov = fov;
			this.camera.updateProjectionMatrix();
		}
	}
};

// Sky: brightness follows the loudness, flashes on beats and accents
var skyboxUpdate = LIGHTS.Skybox.prototype.update;

LIGHTS.Skybox.prototype.update = function() {

	skyboxUpdate.call( this );

	// The show's own sky colour (same sweep as the original, shifted in hue)
	var hue = Show.skyHue();

	if( hue || Groove.active ) {

		var colorPhase = Groove.active ? ( ( Groove.bar / 4 ) % 2 + 2 ) % 2 : ( LIGHTS.time * 0.3 ) % 2;

		if( colorPhase > 1 )
			colorPhase = 1 - ( colorPhase - 1 );

		this.color.setHSV( ( ( 0.6 + colorPhase * 0.35 + hue ) % 1 + 1 ) % 1, 1, 1 );
	}

	if( ! Pulse.active )
		return;

	var v = 0.6 + 0.4 * Pulse.level + 0.25 * Pulse.kick + 0.15 * Pulse.down + 0.35 * Math.min( 1, Pulse.accent );

	this.color.r *= v;
	this.color.g *= v;
	this.color.b *= v;
};

// Stars: dim in quiet parts, sparkle on hi-hats (the original's unused "arp keys" idea)
var starsUpdate = LIGHTS.StarManager.prototype.update;

LIGHTS.StarManager.prototype.update = function() {

	starsUpdate.call( this );

	if( ! Pulse.active )
		return;

	var stars = this.stars,
		base = 0.35 + 0.65 * Pulse.level,
		flash = Pulse.hatFlash,
		key = Pulse.hatKey,
		decay = Math.exp( -LIGHTS.deltaTime / 0.09 ),
		i, il, star, v;

	for( i = 0, il = stars.length; i < il; i++ ) {

		star = stars[ i ];
		star.flash = ( star.flash || 0 ) * decay;

		if( flash && star.key === key )
			star.flash = Math.max( star.flash, 4 * flash );

		if( Pulse.starBurst )
			star.flash = Math.max( star.flash, 6 * Pulse.starBurst );

		v = star.color.r * base + star.flash;
		star.color.r = star.color.g = star.color.b = v;
	}

	Pulse.hatFlash = 0;
	Pulse.starBurst = 0;
};

// Every scene's own elements mark the beat: the ground dots pump in size and the terrain
// brightens, instantly on the beat (stronger on the bar) and back within ~0.15 s
var dotsLaunch = LIGHTS.TerrainDotsManager.prototype.launch;

LIGHTS.TerrainDotsManager.prototype.launch = function() {

	dotsLaunch.call( this );
	this.smartSize = this.material.size;
};

var meshLaunch = LIGHTS.TerrainMeshManager.prototype.launch;

LIGHTS.TerrainMeshManager.prototype.launch = function() {

	meshLaunch.call( this );

	var c = this.material.color;

	this.smartColor = { r: c.r, g: c.g, b: c.b };
};

var meshUpdate = LIGHTS.TerrainMeshManager.prototype.update;

LIGHTS.TerrainMeshManager.prototype.update = function() {

	meshUpdate.call( this );

	if( ! Pulse.active || this.smartColor === undefined )
		return;

	var gain = 0.85 + 0.5 * Pulse.kick + 0.25 * Pulse.down,
		color = this.material.color,
		base = this.smartColor;

	color.r = base.r * gain;
	color.g = base.g * gain;
	color.b = base.b * gain;
};

// Words left over from chorus 1: let them explode, then lay the dots back on the ground
var dotsUpdate = LIGHTS.TerrainDotsManager.prototype.update;

LIGHTS.TerrainDotsManager.prototype.update = function() {

	dotsUpdate.call( this );

	if( Pulse.active && this.smartSize )
		this.material.size = this.smartSize * ( 1 + 0.45 * Pulse.kick + 0.25 * Pulse.down );

	var fx = Show.fx;

	if( ! fx.wordsUntil )
		return;

	if( LIGHTS.time < fx.wordsUntil ) {

		this.explodeWords();
		this.geometry.__dirtyColors = true;
		return;
	}

	fx.wordsUntil = 0;
	this.resetDots();
	this.paintAll( 0, true );
	this.geometry.vertices = this.terrainVertices;
	this.dirtyVertices = true;

	if( fx.dotsAfterWords ) {

		fx.dotsAfterWords = false;
		Transitions.groundDots();
	}
};

// Ground flattened by the break: grow it back when no spotlight chorus does it
var displacementUpdate = LIGHTS.TerrainDisplacement.prototype.update;

LIGHTS.TerrainDisplacement.prototype.update = function() {

	displacementUpdate.call( this );

	var fx = Show.fx;

	if( ! fx.restoreUntil || { 15: 1, 16: 1, 17: 1, 21: 1, 22: 1 }[ LIGHTS.Music.phase.index ] )
		return;

	if( LIGHTS.time < fx.restoreUntil ) {

		this.updateTerrain();
	}
	else {

		fx.restoreUntil = 0;
		this.active = false;
	}
};

// Camera: each show frames the scenes a little differently (only the values a phase sets)
var playerLaunch = LIGHTS.Player.prototype.launch;

LIGHTS.Player.prototype.launch = function() {

	var altitude = this.altitudeTarget, tilt = this.tiltTarget, fov = this.fovTarget;

	playerLaunch.call( this );

	var v = Show.camera( LIGHTS.Music.phase.index );

	if( ! v || ! this.isCamera )
		return;

	if( this.altitudeTarget !== altitude )
		this.altitudeTarget = Math.max( 45, this.altitudeTarget * v.alt );

	if( this.tiltTarget !== tilt )
		this.tiltTarget += v.tilt;

	if( this.fovTarget !== fov )
		this.fovTarget = Math.max( 22, Math.min( 50, this.fovTarget + v.fov ) );
};

// Beats: detected beat grid (file) or the live beat clock
var beatStart = LIGHTS.BeatEvents.prototype.start,
	beatUpdate = LIGHTS.BeatEvents.prototype.update;

LIGHTS.BeatEvents.prototype.start = function() {

	beatStart.call( this );
	this.smartIndex = 0;
};

LIGHTS.BeatEvents.prototype.update = function() {

	if( Smart.mode === 'file' ) {

		var track = Smart.track,
			beats = track.beats,
			time = Smart.now();

		while( this.smartIndex < beats.length && beats[ this.smartIndex ] <= time ) {

			var i = this.smartIndex++,
				beatTime = beats[ i ];

			// Skip stale beats after a stall (hidden tab, seek) so they don't burst
			if( ! track.excluded[ i ] && beatTime >= track.beatStart && beatTime < track.beatEnd && time - beatTime < 0.25 ) {

				this.beat();
			}
		}
	}
	else if( Smart.mode === 'live' ) {

		if( Smart.live.takeBeat() )
			this.beat();
	}
	else {

		beatUpdate.call( this );
	}
};

// Spectrum: same smoothing as the original, data from the analysis
LIGHTS.SpectrumEvents.prototype.update = function() {

	if( LIGHTS.Music.phase.index >= 23 )
		return;

	var frame = Math.floor( Smart.now() * 60 ),
		spectrum = Smart.getSpectrum( frame ) || this.spectrumData[ Math.min( frame, this.spectrumData.length - 1 ) ];

	if( frame <= 0 || ! spectrum )
		return;

	var deltaTime = LIGHTS.deltaTime,
		easingMore = deltaTime * 20,
		easingLess = deltaTime * 10,
		averageSpectrum = this.averageSpectrum,
		displacementSpectrum = this.displacement.spectrum,
		voxSpectrum = this.vox.spectrum,
		offset = this.offset,
		blur = this.blur,
		averageMult = this.amplitude / ( blur * 2 + 1 ),
		il = spectrum.length,
		average, i, j, jl, index, alpha, disp;

	for( i = 0; i < il; i++ ) {

		average = 0;

		for( j = i - blur, jl = i + blur; j <= jl; j++ )
			average += spectrum[ ( j + il ) % il ];

		averageSpectrum[ i ] = average * averageMult;
	}

	for( i = 0; i < il; i++ ) {

		alpha = i + offset * il;
		index = Math.floor( alpha );
		alpha = alpha - index;

		average = averageSpectrum[ index % il ] * ( 1 - alpha ) + averageSpectrum[ ( index + 1 ) % il ] * alpha;
		disp = displacementSpectrum[ i ];

		if( disp > average )
			displacementSpectrum[ i ] -= ( disp - average ) * easingMore;
		else
			displacementSpectrum[ i ] -= ( disp - average ) * easingLess;

		voxSpectrum[ i ] = displacementSpectrum[ i ];
	}

	this.offset = ( this.offset + deltaTime ) % 1;
	this.amplitude -= ( this.amplitude - this.amplitudeTarget ) * ( deltaTime / 4 );
};

// Voice volume: vocal-range energy of the current song
LIGHTS.VolumeEvents.prototype.update = function() {

	var frame = Math.floor( Smart.now() * 60 ),
		peakEase = 5 * LIGHTS.deltaTime,
		average = 0,
		i;

	if( frame <= 0 )
		return;

	for( i = Math.max( 0, frame - 6 ); i <= frame; i++ )
		average += Smart.voxAt( i ) / 512;

	average /= Math.min( 6, frame );

	if( this.voxVolume < average )
		this.voxVolume = average;
	else
		this.voxVolume -= ( this.voxVolume - average ) * peakEase;

	// The voice's sparkler also pumps with the beat
	this.vox.volume = this.voxVolume + ( Pulse.active ? 0.45 * Pulse.kick + 0.3 * Pulse.accent + 0.9 * Pulse.voice : 0 );
};

// Camera speed follows the tempo
var playerTween = LIGHTS.Player.prototype.tween;

LIGHTS.Player.prototype.tween = function( duration ) {

	this.velocityTarget *= Smart.speedFactor();
	playerTween.call( this, duration );
};

// Home: the "TWEET THIS" button becomes "NEW SONG"
var homeLaunchPlay = LIGHTS.Home.prototype.launchPlay;

LIGHTS.Home.prototype.launchPlay = function() {

	LIGHTS.images.tweetButton = buttonCanvas( LIGHTS.images.tweetButton, 'NEW SONG' );
	homeLaunchPlay.call( this );
};

LIGHTS.Home.prototype.onClick = function() {

	if( this.openTweetThis ) {

		this.openTweetThis = false;
		UI.openPicker();
	}
};

function buttonCanvas( image, text ) {

	if( image && image.smartButton )
		return image;

	var canvas = document.createElement( 'canvas' ),
		g = canvas.getContext( '2d' );

	canvas.width = canvas.height = 128;
	g.beginPath();
	g.arc( 64, 64, 48.5, 0, Math.PI * 2 );
	g.fillStyle = '#fff';
	g.fill();
	g.fillStyle = '#0c0c0c';
	g.font = 'bold 20px "PT Sans Narrow", sans-serif';
	g.textAlign = 'center';
	g.textBaseline = 'middle';
	g.fillText( text, 64, 65 );
	canvas.smartButton = true;

	return canvas;
}

// _______________________________________________________________________________________________ Groove patches

// Floating words bob on 2- or 4-bar cycles
var wordInitGroove = LIGHTS.TerrainDotsWord.prototype.initialize;

LIGHTS.TerrainDotsWord.prototype.initialize = function( word, position ) {

	wordInitGroove.call( this, word, position );
	this.floatFreq = Math.random() < 0.5 ? 4 : 8;
};

onMusicalTime( LIGHTS.TerrainDotsWord.prototype, 'update' );

// Spotlights move like concert moving heads: on every beat each one snaps (in about 0.1 s)
// to the next position of its pattern and holds, so the movement itself marks the beat.
// The first beat of a bar throws them wide; the patterns alternate so the beams cross.
var SPOT_PATTERNS = [
	[ 0.8, -0.4, 0.55, -0.4 ],  // wide on the bar, crossing in between
	[ 0.8, 0.3, -0.6, 0.3 ],
	[ 0.7, -0.7, 0.7, -0.7 ]    // left / right every beat
];

LIGHTS.CannonsTile.prototype.update = function() {

	var cannons = this.cannons,
		spots = this.spots,
		manager = this.manager,
		ease = 1 - Math.exp( -LIGHTS.deltaTime / 0.045 ),
		calm = Pulse.level < 0.45,
		i, il, cannon, rotX, side, pattern, step, target;

	for( i = 0, il = cannons.length; i < il; i++ ) {

		cannon = cannons[ i ];

		if( Groove.active ) {

			side = cannon.offset > 0 ? 1 : -1;
			pattern = SPOT_PATTERNS[ Math.floor( cannon.freq * 10 ) % SPOT_PATTERNS.length ];

			// The move starts ~30 ms early so it lands on the beat; quieter passages move on
			// every other beat
			step = ( ( Math.floor( Groove.beatPos + 0.03 / Groove.period ) % 4 ) + 4 ) % 4;

			if( calm )
				step -= step % 2;

			target = side * rad45 * pattern[ step ];

			if( cannon.smartRot === undefined )
				cannon.smartRot = cannon.rotX;

			cannon.smartRot += ( target - cannon.smartRot ) * ease;
			rotX = cannon.smartRot;
		}
		else {

			rotX = Math.sin( cannon.offset + manager.rotationTime * cannon.freq ) * rad45;
		}

		cannon.rotation.x = rotX;
		spots[ i ].rotation.x = rotX;
	}
};

// Spotlights move from the moment the spotlight scene starts, and flash with the beat
// (until the end fade takes over)
var cannonUpdateGroove = LIGHTS.CannonManager.prototype.update;

LIGHTS.CannonManager.prototype.update = function() {

	if( ! Groove.active )
		return cannonUpdateGroove.call( this );

	var fading = LIGHTS.time >= LIGHTS.Music.phase.times[ 22 ] - 2,
		tiles = this.tiles,
		i, il;

	this.rotationTime += LIGHTS.deltaTime;

	for( i = 0, il = tiles.length; i < il; i++ )
		tiles[ i ].update();

	if( fading ) {

		this.fadeMaterials();
		return;
	}

	var materials = this.spotMaterials,
		colors = this.spotColors,
		boost = Math.min( 1.3, 0.65 + 0.4 * Pulse.kick + 0.1 * Pulse.down + 0.3 * Math.min( 1, Pulse.accent ) ),
		color;

	for( i = 0, il = materials.length; i < il; i++ ) {

		color = materials[ i ].color;
		color.setHex( colors[ i ] );
		color.r *= boost;
		color.g *= boost;
		color.b *= boost;
	}
};

// Ground circles are born on the first beat of each bar and live three bars
var circlesUpdate = LIGHTS.MapCircles.prototype.update;

LIGHTS.MapCircles.prototype.update = function() {

	if( ! Groove.active )
		return circlesUpdate.call( this );

	var circles = this.circles,
		count = this.circleCount,
		deltaTime = LIGHTS.deltaTime,
		i, circle;

	if( Groove.downbeat ) {

		// Restart the third of the circles that has grown the most
		var order = circles.slice( 0, count ).sort( function( a, b ) { return b.radius - a.radius; } );

		for( i = 0; i < Math.ceil( count / 3 ); i++ )
			this.resetCircle( order[ i ] );
	}

	for( i = 0; i < count; i++ ) {

		circle = circles[ i ];
		circle.life = 99;
		circle.radius += deltaTime * circle.speed;
		circle.scale.x = circle.scale.y = circle.radius * circle.size;
	}
};

// Balls change shape fast enough to land on the beat (the original's slowest took ~0.75 s)
var behaviourInit = LIGHTS.BallBehaviour.prototype.initialize;

LIGHTS.BallBehaviour.prototype.initialize = function( manager, index ) {

	behaviourInit.call( this, manager, index );
	this.fatEaseOriginal = this.fatEase;
};

var behaviourUpdate = LIGHTS.BallBehaviour.prototype.update;

LIGHTS.BallBehaviour.prototype.update = function() {

	var original = this.fatEase;

	if( Pulse.active )
		this.fatEase = Math.max( original, 14 );

	behaviourUpdate.call( this );
	this.fatEase = original;
};

// _______________________________________________________________________________________________ UI

// "101 BPM", or "90 → 120 → 100 BPM" when the song changes tempo
function tempoSummary( track ) {

	if( ! track.tempoVaries || ! track.tempoChanges.length )
		return Math.round( track.bpm ) + ' BPM';

	var points = track.tempoPoints,
		at = function( t ) {

			var best = points[ 1 ], bd = Infinity;

			for( var i = 0; i < points.length; i += 2 ) {

				if( Math.abs( points[ i ] - t ) < bd ) {

					bd = Math.abs( points[ i ] - t );
					best = points[ i + 1 ];
				}
			}

			return Math.round( best );
		},
		list = [ at( track.tempoChanges[ 0 ].t - 6 ) ];

	for( var i = 0; i < track.tempoChanges.length; i++ )
		list.push( at( track.tempoChanges[ i ].t + 6 ) );

	return list.join( ' → ' ) + ' BPM';
}

function clock( t ) {

	return Math.floor( t / 60 ) + ':' + ( '0' + Math.floor( t % 60 ) ).slice( -2 );
}

// Vocal segments and the reason each phase starts where it does
function laneMarkup( track, total ) {

	var html = '', i,
		segs = track.vocalSegments,
		reasonText = { vocal: 'singer starts', 'vocal-end': 'singer stops', tempo: 'tempo change', rhythm: 'rhythm change', change: 'section change' };

	for( i = 0; i < segs.length; i += 2 )
		html += '<span class="sp-voc" style="left:' + ( segs[ i ] / total * 100 ).toFixed( 2 ) + '%;width:' +
			( Math.max( 0.3, ( segs[ i + 1 ] - segs[ i ] ) / total * 100 ) ).toFixed( 2 ) + '%"></span>';

	for( i = 0; i < track.phaseTimes.length - 1; i++ ) {

		var reason = track.phaseReasons[ i ];

		if( reason === 'bar' || reason === 'change' || reason === 'end' )
			continue;

		html += '<span class="sp-mark sp-mark-' + reason + '" style="left:' + ( track.phaseTimes[ i ] / total * 100 ).toFixed( 2 ) +
			'%" title="' + clock( track.phaseTimes[ i ] ) + ' · ' + reasonText[ reason ] + '"></span>';
	}

	return html;
}

var UI = LIGHTS.SmartUI = {

	build: function() {

		var panel = this.panel = document.createElement( 'div' );

		panel.id = 'smart_panel';
		panel.innerHTML =
			'<div class="sp-head">' +
				'<div class="sp-title">Bring your own music</div>' +
				'<div class="sp-sub">Tempo, beats, sections (verse, chorus, break) and vocals are analyzed automatically, and the lights follow them.</div>' +
			'</div>' +
			'<div class="sp-actions">' +
				'<button type="button" class="sp-btn sp-primary" data-act="file">Upload a song</button>' +
				'<button type="button" class="sp-btn" data-act="display">Playing audio</button>' +
				'<button type="button" class="sp-btn" data-act="mic">Microphone</button>' +
				'<button type="button" class="sp-btn sp-ghost" data-act="original">Original song</button>' +
			'</div>' +
			'<div class="sp-mine" hidden></div>' +
			'<div class="sp-hint">or drop a file anywhere · MP3 · WAV · OGG · M4A · FLAC · songs stay on your computer</div>' +
			'<div class="sp-status" hidden>' +
				'<div class="sp-status-text"></div>' +
				'<div class="sp-bar"><div class="sp-bar-fill"></div></div>' +
			'</div>' +
			'<div class="sp-result" hidden>' +
				'<div class="sp-song"><span class="sp-dot"></span><span class="sp-name"></span></div>' +
				'<div class="sp-meta"></div>' +
				'<div class="sp-timeline"></div>' +
				'<div class="sp-lanes"></div>' +
				'<div class="sp-legend"></div>' +
				'<div class="sp-show" hidden><span class="sp-show-text"></span>' +
					'<button type="button" class="sp-link sp-remix" data-act="remix" title="Another scene order and camera (R)">Remix &#x21bb;</button></div>' +
				'<div class="sp-go"></div>' +
				'<div class="sp-tip">Move the mouse to guide the voice · click to fly faster · T: tap-sync your speakers</div>' +
				'<button type="button" class="sp-link" data-act="change">Change song</button>' +
			'</div>';

		document.body.appendChild( panel );

		var input = this.input = document.createElement( 'input' );

		input.type = 'file';
		input.accept = 'audio/*,.mp3,.wav,.ogg,.oga,.m4a,.aac,.flac,.opus,.webm';
		input.style.display = 'none';
		input.addEventListener( 'change', function() {

			if( input.files && input.files[ 0 ] )
				useFile( input.files[ 0 ], { remember: true } );

			input.value = '';
		} );
		document.body.appendChild( input );

		panel.addEventListener( 'click', function( e ) {

			var btn = e.target.closest( '[data-act]' );

			if( ! btn || btn.disabled )
				return;

			switch( btn.getAttribute( 'data-act' ) ) {

				case 'file':     input.click(); break;
				case 'display':  useLive( 'display' ); break;
				case 'mic':      useLive( 'mic' ); break;
				case 'original': useOriginal(); break;
				case 'change':   UI.openPicker(); break;
				case 'remix':    UI.remix(); break;
				case 'mine':     useUrl( btn.getAttribute( 'data-url' ), btn.textContent ); break;
				case 'saved':    useSaved( btn.getAttribute( 'data-id' ) ); break;
				case 'forget':   SongStore.remove( btn.getAttribute( 'data-id' ) ).then( function() { UI.listMine(); } ); break;
			}
		} );

		// Exit button + HUD shown during the experience
		var exit = this.exit = document.createElement( 'button' );

		exit.id = 'smart_exit';
		exit.type = 'button';
		exit.title = 'Back (Esc)';
		exit.innerHTML = '&#x2715;';
		exit.addEventListener( 'click', function() { UI.leave(); } );
		document.body.appendChild( exit );

		// Light flash over the scene (beats, snares, accents)
		var flash = this.flashEl = document.createElement( 'div' );

		flash.id = 'smart_flash';
		document.body.appendChild( flash );

		var toast = this.toastEl = document.createElement( 'div' );

		toast.id = 'smart_toast';
		document.body.appendChild( toast );

		var hud = this.hudEl = document.createElement( 'div' );

		hud.id = 'smart_hud';
		hud.innerHTML = '<span class="sh-beat"></span><span class="sh-text"></span>';
		document.body.appendChild( hud );

		// Drag & drop
		var dragDepth = 0;

		window.addEventListener( 'dragenter', function( e ) {

			e.preventDefault();
			dragDepth++;
			document.body.classList.add( 'smart-dragging' );
		} );
		window.addEventListener( 'dragleave', function() {

			if( --dragDepth <= 0 ) {

				dragDepth = 0;
				document.body.classList.remove( 'smart-dragging' );
			}
		} );
		window.addEventListener( 'dragover', function( e ) { e.preventDefault(); } );
		window.addEventListener( 'drop', function( e ) {

			e.preventDefault();
			dragDepth = 0;
			document.body.classList.remove( 'smart-dragging' );

			if( LIGHTS.Lights.instance && LIGHTS.Lights.instance.experiencePlaying )
				return;

			var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[ 0 ];

			if( file ) {

				UI.openPicker( true );
				useFile( file, { remember: true } );
			}
		} );

		window.addEventListener( 'keydown', function( e ) {

			if( e.key === 'Escape' && LIGHTS.Lights.instance && LIGHTS.Lights.instance.experiencePlaying )
				UI.leave();
			else if( e.key === 'h' || e.key === 'H' )
				UI.toggleHud();
			else if( ( e.key === 'r' || e.key === 'R' ) && ! ( LIGHTS.Lights.instance && LIGHTS.Lights.instance.experiencePlaying ) )
				UI.remix();
			else if( e.key === '[' || e.key === ']' )
				UI.nudgeOffset( e.key === ']' ? 10 : -10 );
			else if( e.key === 't' || e.key === 'T' )
				UI.startTapSync();
			else if( e.key === ' ' && UI.tapSync ) {

				e.preventDefault();
				UI.tap();
			}
		} );

		this.listMine( true );

		this.status = panel.querySelector( '.sp-status' );
		this.statusText = panel.querySelector( '.sp-status-text' );
		this.barFill = panel.querySelector( '.sp-bar-fill' );
		this.result = panel.querySelector( '.sp-result' );
		this.updateHud();
	},

	setButtons: function( enabled ) {

		var buttons = this.panel.querySelectorAll( '.sp-actions .sp-btn, .sp-chip' );

		for( var i = 0; i < buttons.length; i++ )
			buttons[ i ].disabled = ! enabled;
	},

	openPicker: function( keepBusy ) {

		this.panel.classList.remove( 'sp-compact' );
		this.panel.classList.add( 'sp-open' );
		this.result.hidden = true;

		if( ! keepBusy )
			this.status.hidden = ! Smart.busy;
	},

	loaded: function() {

		this.isLoaded = true;
		this.panel.classList.add( 'sp-visible' );
	},

	showBusy: function( text, progress ) {

		this.setButtons( false );
		this.status.hidden = false;
		this.status.classList.remove( 'sp-error' );
		this.result.hidden = true;
		this.statusText.textContent = text;
		this.barFill.style.width = Math.round( Math.max( 0, Math.min( 1, progress ) ) * 100 ) + '%';
	},

	showError: function( text ) {

		this.setButtons( true );
		this.panel.classList.remove( 'sp-compact' );
		this.status.hidden = false;
		this.status.classList.add( 'sp-error' );
		this.statusText.textContent = text;
		this.barFill.style.width = '0%';
	},

	showReady: function() {

		this.setButtons( true );
		this.status.hidden = true;
		this.result.hidden = false;
		this.panel.classList.add( 'sp-compact' );
		this.panel.classList.remove( 'sp-open' );

		this.panel.querySelector( '.sp-name' ).textContent = Smart.title;

		var meta = [], timeline = '', lanes = '', legend = '', go;

		if( Smart.mode === 'file' ) {

			var track = Smart.track,
				sections = track.sections,
				total = track.endTime;

			meta.push( tempoSummary( track ) );
			meta.push( Math.floor( track.duration / 60 ) + ':' + ( '0' + Math.floor( track.duration % 60 ) ).slice( -2 ) );
			meta.push( sections.length + ' sections' );

			var entries = track.vocalEvents.filter( function( e ) { return e.kind === 'vocal'; } ),
				firstVocal = entries.filter( function( e ) { return e.s >= 1; } )[ 0 ] || entries[ 0 ];

			if( firstVocal )
				meta.push( 'singer enters ' + clock( firstVocal.t ) );

			lanes = laneMarkup( track, total );
			legend = '<span class="sp-key sp-key-voc"></span>vocals' +
				'<span class="sp-key sp-key-vocal"></span>scene change on singer' +
				( track.tempoChanges.length ? '<span class="sp-key sp-key-tempo"></span>on tempo change' : '' ) +
				'<span class="sp-key sp-key-rhythm"></span>on rhythm change';

			for( var i = 0; i < sections.length; i++ ) {

				var s = sections[ i ],
					w = Math.max( 0.6, ( s.end - s.start ) / total * 100 ),
					light = Math.round( 22 + s.energy * 48 );

				timeline += '<span class="sp-seg sp-' + s.label + '" style="width:' + w.toFixed( 2 ) + '%;--l:' + light + '%" title="' +
					LABEL_TEXT[ s.label ] + '"><i>' + LABEL_TEXT[ s.label ] + '</i></span>';
			}
		}
		else if( Smart.mode === 'live' ) {

			meta.push( 'Live mode' );
			meta.push( '<span class="sp-live-bpm">listening…</span>' );
			meta.push( 'tempo and sections are detected in real time' );
		}
		else {

			meta.push( 'original hand-made choreography' );
		}

		go = LIGHTS.Lights.instance && LIGHTS.Lights.instance.director && this.isPlayedOnce ?
			'Ready — press <b>REPLAY</b>' :
			'Ready — press <b>PLAY</b>';

		this.panel.querySelector( '.sp-meta' ).innerHTML = meta.join( ' <span class="sp-sep">·</span> ' );
		this.panel.querySelector( '.sp-timeline' ).innerHTML = timeline;
		this.panel.querySelector( '.sp-timeline' ).hidden = ! timeline;
		this.panel.querySelector( '.sp-lanes' ).innerHTML = lanes;
		this.panel.querySelector( '.sp-lanes' ).hidden = ! lanes;
		this.panel.querySelector( '.sp-legend' ).innerHTML = legend;
		this.panel.querySelector( '.sp-legend' ).hidden = ! legend;
		this.panel.querySelector( '.sp-go' ).innerHTML = go;
		this.updateShow();
	},

	updateShow: function() {

		var line = this.panel.querySelector( '.sp-show' );

		line.hidden = Smart.mode !== 'file';

		if( Smart.mode === 'file' )
			line.firstChild.textContent = Show.describe() + ' ';
	},

	remix: function() {

		if( Smart.mode !== 'file' || ( LIGHTS.Lights.instance && LIGHTS.Lights.instance.experiencePlaying ) )
			return;

		Show.remix();
		this.updateShow();
		this.toast( 'Show ' + ( Show.index + 1 ) + ' of ' + SHOWS.length );
	},

	// "Your songs": songs saved in this browser, plus songs in the local my-music/ folder (listed
	// by the local web server). On first load, the most recently used saved song is prepared
	// right away so PLAY works at once.
	listMine: function( autoload ) {

		var box = this.panel.querySelector( '.sp-mine' ),
			self = this;

		var folder = window.fetch ? fetch( 'my-music/' ).then( function( r ) {

			return r.ok ? r.text() : '';

		} ).catch( function() { return ''; } ) : Promise.resolve( '' );

		Promise.all( [ SongStore.list(), folder ] ).then( function( found ) {

			var saved = found[ 0 ], html = found[ 1 ],
				re = /href="([^"?#]+\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|webm))"/gi,
				seen = {}, items = [], m;

			saved.forEach( function( song ) {

				var name = song.title || cleanTag( song.name.replace( /\.[^.]+$/, '' ) ) || song.name;

				items.push( '<span class="sp-chip-wrap"><button type="button" class="sp-chip" data-act="saved" data-id="' + escapeHtml( song.id ) +
					'" title="Saved in this browser">' + escapeHtml( name ) + '</button><button type="button" class="sp-forget" data-act="forget" data-id="' +
					escapeHtml( song.id ) + '" title="Forget this song" aria-label="Forget ' + escapeHtml( name ) + '">&#x2715;</button></span>' );
			} );

			while( ( m = re.exec( html ) ) ) {

				if( seen[ m[ 1 ] ] )
					continue;

				seen[ m[ 1 ] ] = true;

				var fileName = decodeURIComponent( m[ 1 ].split( '/' ).pop() ),
					label = cleanTag( fileName.replace( /\.[^.]+$/, '' ) ) || fileName;

				items.push( '<button type="button" class="sp-chip" data-act="mine" data-url="my-music/' + m[ 1 ].split( '/' ).pop() +
					'" title="From the my-music folder">' + escapeHtml( label ) + '</button>' );
			}

			box.innerHTML = items.length ? '<span class="sp-mine-label">Your songs</span>' + items.join( '' ) : '';
			box.hidden = ! items.length;

			if( autoload && saved.length && ! Smart.mode && ! Smart.busy )
				useSaved( saved[ 0 ].id );
		} );
	},

	onPlay: function() {

		this.isPlayedOnce = true;
		document.body.classList.add( 'smart-playing' );
		this.exit.title = Smart.mode === 'live' ? 'Finish (Esc)' : 'Back (Esc)';
	},

	onHome: function() {

		this.tapSync = null;
		document.body.classList.remove( 'smart-playing' );

		if( Smart.ready )
			this.showReady();
		else
			this.openPicker();
	},

	leave: function() {

		var app = LIGHTS.Lights.instance;

		if( ! app || ! app.experiencePlaying )
			return;

		if( Smart.mode === 'live' && Smart.live && ! Smart.live.stopRequested )
			Smart.live.requestStop();
		else
			app.playHome();
	},

	flash: function( opacity, hex ) {

		if( ! this.flashEl )
			return;

		var o = opacity > 0.004 ? opacity.toFixed( 3 ) : '0';

		if( o !== this.flashOpacity ) {

			this.flashOpacity = o;
			this.flashEl.style.opacity = o;
		}

		if( hex !== undefined && hex !== this.flashHex ) {

			this.flashHex = hex;
			this.flashEl.style.setProperty( '--flash', '#' + ( '000000' + hex.toString( 16 ) ).slice( -6 ) );
		}
	},

	toast: function( text, duration ) {

		var el = this.toastEl;

		el.textContent = text;
		el.classList.add( 'on' );
		clearTimeout( this.toastTimer );
		this.toastTimer = setTimeout( function() { el.classList.remove( 'on' ); }, duration || 1600 );
	},

	// Manual sync trim for setups with extra latency (Bluetooth speakers, TVs)
	nudgeOffset: function( ms ) {

		Smart.syncOffset = Math.max( -500, Math.min( 500, Smart.syncOffset + ms ) );
		saveOffset( Smart.syncOffset );

		var v = Smart.syncOffset;

		this.toast( v === 0 ? 'Visual timing: default' :
			'Visual timing: ' + Math.abs( v ) + ' ms ' + ( v > 0 ? 'earlier' : 'later' ) + '  ·  [ / ] to adjust' );
	},

	// Tap-along calibration: tap Space on the beat; the median offset between the taps and the
	// song's beats is the delay the speakers add after the player's position
	startTapSync: function() {

		var app = LIGHTS.Lights.instance;

		if( Smart.mode !== 'file' || ! app || ! app.experiencePlaying ) {

			this.toast( 'Tap sync works while an uploaded song is playing' );
			return;
		}

		this.tapSync = { offsets: [] };
		this.toast( 'Tap SPACE on every beat you hear — 0 / 8', 8000 );
	},

	tap: function() {

		var track = Smart.track,
			beats = track.beats,
			t = LIGHTS.musicAudio.currentTime,
			lo = 0, hi = beats.length - 1, offsets = this.tapSync.offsets;

		while( hi - lo > 1 ) {

			var m = ( lo + hi ) >> 1;

			if( beats[ m ] <= t ) lo = m;
			else hi = m;
		}

		var b = Math.abs( beats[ hi ] - t ) < Math.abs( beats[ lo ] - t ) ? beats[ hi ] : beats[ lo ],
			offset = t - b;

		if( Math.abs( offset ) < track.beatPeriod * 0.4 )
			offsets.push( offset );

		if( offsets.length < 8 ) {

			this.toast( 'Tap SPACE on every beat you hear — ' + offsets.length + ' / 8', 8000 );
			return;
		}

		offsets.sort( function( a, b ) { return a - b; } );

		// People tap ~30 ms ahead of the beat they hear
		var delay = Math.max( -0.1, Math.min( 0.5, offsets[ offsets.length >> 1 ] + 0.03 ) );

		if( Math.abs( delay ) < 0.02 )
			delay = 0;

		Smart.audioDelay = delay;
		Smart.syncOffset = 0;
		saveSetting( 'lightsSmartAudioDelay', delay );
		saveOffset( 0 );
		this.tapSync = null;
		this.toast( delay ? 'Synced: your speakers add ' + Math.round( delay * 1000 ) + ' ms — visuals adjusted' : 'Synced: no extra speaker delay', 4000 );
	},

	toggleHud: function() {

		Smart.hud = ! Smart.hud;
		document.body.classList.toggle( 'smart-hud', Smart.hud );
	},

	pulse: function() {

		var beat = this.hudEl && this.hudEl.firstChild;

		if( ! beat )
			return;

		beat.classList.remove( 'on' );
		void beat.offsetWidth;
		beat.classList.add( 'on' );
	},

	updateHud: function() {

		requestAnimationFrame( bind( this, this.updateHud ) );

		if( Smart.mode === 'live' && Smart.live && Smart.live.tempoConfidence > 0.1 ) {

			var liveBpm = this.panel && this.panel.querySelector( '.sp-live-bpm' );

			if( liveBpm )
				liveBpm.textContent = Math.round( Smart.live.bpm ) + ' BPM';
		}

		if( ! Smart.hud || ! this.hudEl )
			return;

		var app = LIGHTS.Lights.instance,
			text = '';

		if( app && app.experiencePlaying ) {

			var label = Smart.sectionAt( LIGHTS.time ),
				bpm = Smart.mode === 'file' ? Smart.track.bpm : Smart.mode === 'live' ? Smart.live.bpm : 120;

			var index = LIGHTS.Music.phase.index,
				why = Smart.mode === 'file' && index > 0 ? Smart.track.phaseReasons[ index - 1 ] : Smart.mode === 'live' && Smart.live ? Smart.live.lastReason : '',
				whyText = { vocal: 'started on the singer', 'vocal-end': 'started as the singer stopped', tempo: 'started on a tempo change', rhythm: 'started on a rhythm change' }[ why ];

			text = ( LABEL_TEXT[ label ] || '' ) + ' · ' + Math.round( bpm ) + ' BPM · phase ' + index + ( whyText ? ' (' + whyText + ')' : '' );
		}
		else if( Smart.mode === 'live' && Smart.live ) {

			text = 'Live · ' + Math.round( Smart.live.bpm ) + ' BPM';
		}

		this.hudEl.lastChild.textContent = text;
	}
};

if( document.readyState === 'loading' )
	document.addEventListener( 'DOMContentLoaded', function() { UI.build(); } );
else
	UI.build();

} )();
