// Login, 2FA, registro y recuperar contraseña
// Parte de la interfaz de Grupo NAR — ver public/index.html para el orden
// en que se cargan estos archivos (todos comparten el mismo ámbito global).

function buildGateShell(panelInnerHtml){
  const wrap = document.createElement('div');
  wrap.className = 'gate-stage';
  wrap.innerHTML = `
    <div class="gate-shell">
      <div class="gate-brand">
        <svg class="gate-brand-watermark" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 1080 1080" style="enable-background:new 0 0 1080 1080;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#22130B;}
	.st1{fill:#58130E;}
	.st2{fill:#976B60;}
	.st3{fill:#8E816F;}
	.st4{fill:#A48887;}
	.st5{fill:#D2D2D2;}
	.st6{fill:#FFFFFF;}
</style>
<g>
	<g>
		<polygon class="st6" points="89.3,763 89.3,763 492.8,359.5 896.3,763 896.3,763 938.7,763 938.7,763 492.8,317 46.9,763 
			46.9,763 		"/>
		<g>
			<polygon class="st6" points="513.8,432.9 492.6,411.7 141.3,763 141.3,763 183.7,763 183.7,763 			"/>
			<polygon class="st6" points="587.2,317 566,338.3 587.2,359.5 587.2,359.5 990.7,763 990.7,763 1033.1,763 1033.1,763 			"/>
		</g>
	</g>
</g>
</svg>
        <div class="gate-brand-mark">
          <svg class="gnar-logo-mark" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 1080 1080" style="enable-background:new 0 0 1080 1080;" xml:space="preserve">
<style type="text/css">
	.st0{fill:#22130B;}
	.st1{fill:#58130E;}
	.st2{fill:#976B60;}
	.st3{fill:#8E816F;}
	.st4{fill:#A48887;}
	.st5{fill:#D2D2D2;}
	.st6{fill:#FFFFFF;}
</style>
<g>
	<g>
		<polygon class="st6" points="89.3,615.1 89.3,615.1 492.8,211.6 896.3,615.1 896.3,615.1 938.7,615.1 938.7,615.1 492.8,169.2 
			46.9,615.1 46.9,615.1 		"/>
		<g>
			<polygon class="st6" points="513.8,285 492.6,263.8 141.3,615.1 141.3,615.1 183.7,615.1 183.7,615.1 			"/>
			<polygon class="st6" points="587.2,169.2 566,190.4 587.2,211.6 587.2,211.6 990.7,615.1 990.7,615.1 1033.1,615.1 1033.1,615.1 
							"/>
		</g>
	</g>
	<g>
		<path class="st6" d="M251.8,910.2v-1.6h4.9v-33.5h-4.9v-1.6h15.3v1.6H262v33.5h8.4c0.4,0,0.9,0,1.4-0.1c2.3-0.5,3.9-2.7,4.9-6.4
			l1-4.1h1.2l-0.3,12.2H251.8z"/>
		<path class="st6" d="M309.2,884.6l-0.9-2.9c0-0.2-0.1-0.4-0.2-0.6c-1.3-4-3.4-5.9-6.3-5.9h-9.8v15.3h12.6v1.8h-12.6v16.4h9.8
			c0.7,0,1.3-0.1,2-0.3c2-0.7,3.5-2.8,4.5-6.2l0.9-2.9h1.2l-0.3,11H282v-1.6h4.9v-33.5H282v-1.6h28.2l0.3,11H309.2z"/>
		<path class="st6" d="M354.1,893.7v1.6h-4.6v14.9l-5.2-1.9c-0.2,0.2-0.5,0.3-0.8,0.5c-2.5,1.3-5.3,2-8.3,2c-4.2,0-8-1.3-11.4-3.9
			c-4.6-3.7-7-8.8-7-15.3c0-5.7,1.9-10.3,5.7-13.9c3.5-3.2,7.7-4.8,12.6-4.8c2.9,0,5.6,0.6,8.2,1.9l5.3-1.1l0.3,11.9h-1.6
			c-1-3.4-2.1-5.9-3.3-7.5c-1.9-2.3-4.9-3.5-9.1-3.5c-1.1,0-2.2,0.1-3.2,0.4c-5.9,1.5-8.8,7.2-8.8,16.9c0,11.3,4.1,17,12.2,17.1
			c0.3,0,0.7,0,1-0.1c3.4-0.3,6.2-1.6,8.2-4.1v-9.5h-5.5v-1.6H354.1z"/>
		<path class="st6" d="M380.1,910.2v-1.6h4l-4.6-11.9h-12.8l-4.6,11.9h3c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5h-10.9v-1.6h3.8
			l13.7-35.1h2.3l14,35.1h2.1c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5H380.1z M373.1,880.2l-5.7,14.8h11.4L373.1,880.2z"/>
		<path class="st6" d="M395.8,910.2v-1.6h4.9v-33.5h-4.9v-1.6h15.3v1.6h-5.1v33.5h8.4c0.4,0,0.9,0,1.4-0.1c2.3-0.5,3.9-2.7,4.9-6.4
			l1-4.1h1.2l-0.3,12.2H395.8z"/>
		<path class="st6" d="M457.1,910.8c-5.6,0-10.2-1.9-13.7-5.6c-3.3-3.6-4.9-8.1-4.9-13.4c0-4.4,1.2-8.3,3.5-11.7
			c3.4-4.8,8.3-7.1,14.8-7.1c2,0,3.9,0.2,5.7,0.7c2.9,0.7,4.9,1.7,6,2.9c0-1.1,0.1-1.9,0.2-2.4c0.2-0.6,0.8-0.9,1.6-0.9l0.2,11.2
			h-1.5c-0.3-0.9-0.6-1.8-1-2.6c-2.3-4.8-6-7.2-11.1-7.2c-2.2,0-4.3,0.6-6.1,1.7c-4.2,2.7-6.3,7.9-6.3,15.5c0,3.5,0.5,6.6,1.4,9.2
			c1.9,5.3,5.5,8,10.8,8c6.2,0,10.4-3.4,12.5-10.1h1.5v11.5c-0.5,0-0.9-0.1-1.2-0.2c-0.5-0.2-0.7-1.2-0.7-2.9
			C465.1,909.7,461.2,910.8,457.1,910.8z"/>
		<path class="st6" d="M506.2,876.6c4.7,3.5,7,8.6,7,15.3c0,5.7-1.9,10.4-5.8,14.1c-3.5,3.3-7.6,4.9-12.4,4.9
			c-4.3,0-8.1-1.3-11.4-3.9c-4.5-3.6-6.8-8.7-6.8-15.3c0-5.7,1.9-10.3,5.7-13.9c3.5-3.2,7.7-4.8,12.6-4.8
			C499.4,873,503,874.2,506.2,876.6z M499.7,908.2c4.9-2.2,7.4-7.7,7.4-16.6c0-11.2-4.1-16.9-12.1-17c-1.1,0-2.2,0.1-3.2,0.4
			c-5.9,1.5-8.8,7.2-8.8,16.9c0,2.9,0.3,5.5,0.9,7.8c1.7,6.3,5.5,9.5,11.4,9.5C496.8,909.1,498.3,908.8,499.7,908.2z"/>
		<path class="st6" d="M544.3,873.6h12.5v1.6H552v34.8l-2.8,0.6l-24-30.2v28.3h3.6c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5h-12.5
			v-1.6h4.9v-33.5h-4.9v-1.6h8.5l23.2,29v-27.4h-5.2V873.6z"/>
		<path class="st6" d="M584.5,907c-2.6,2.5-6.2,3.8-10.9,3.8c-4,0-7.6-1-10.7-3.1c0,0.9,0,1.4-0.1,1.8c-0.2,0.6-0.7,0.9-1.7,0.9
			v-12.6h1.8c0.7,7.5,4.2,11.3,10.4,11.4c1.6,0,3-0.3,4.3-0.9c2.8-1.3,4.2-3.3,4.2-6.2c0-1.1-0.3-2.1-0.8-3.1c-1-1.7-3.3-3.3-7-4.9
			c-4-1.7-6.3-2.7-7-3.1c-3.8-2.2-5.7-4.9-5.7-8.4c0-2.3,0.8-4.3,2.4-6c2.4-2.4,5.9-3.7,10.3-3.7c3.6,0,6.9,0.8,9.8,2.4
			c0-0.5,0-0.9,0.1-1.2c0.2-0.6,0.7-0.9,1.7-0.9V884h-1.8c0-2.3-0.5-4.2-1.7-5.8c-1.8-2.3-4.4-3.5-7.8-3.5c-1.4,0-2.6,0.2-3.8,0.7
			c-2.6,1.1-4,3-4,5.7c0,1,0.2,2,0.7,2.9c0.9,1.6,3.2,3.2,6.8,4.8c4,1.8,6.4,2.8,7.1,3.2c3.9,2.2,5.9,5.1,5.9,8.7
			C587.2,903.1,586.3,905.3,584.5,907z"/>
		<path class="st6" d="M590.8,873.6h15v1.6H601v21c0,2.6,0.3,4.9,0.9,6.7c1.3,4.2,4.4,6.3,9.4,6.3c0.5,0,1,0,1.5-0.1
			c5.9-0.6,8.8-4.9,8.8-12.8v-21.1h-4.9v-1.6h11.9v1.6h-4.9v20.8c0,2.3-0.2,4.3-0.7,6.1c-1.5,5.9-5.8,8.8-13,8.8
			c-9.4,0-14.2-4.8-14.2-14.4v-21.3h-4.9V873.6z"/>
		<path class="st6" d="M631.3,910.2v-1.6h4.9v-33.5h-4.9v-1.6h15.3v1.6h-5.1v33.5h8.4c0.4,0,0.9,0,1.4-0.1c2.3-0.5,3.9-2.7,4.9-6.4
			l1-4.1h1.2l-0.3,12.2H631.3z"/>
		<path class="st6" d="M667.9,910.2v-1.6h5.8v-33.5h-3.3c-3.1,0.2-5.4,2.4-6.7,6.4l-1,4.1h-1.7l0.3-12h30.2l0.3,12h-1.7l-1-4.1
			c0-0.1-0.1-0.2-0.1-0.4c-1.1-4-3.3-6-6.6-6H679v33.5h4.2c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5H667.9z"/>
		<path class="st6" d="M718.3,910.2v-1.6h4l-4.6-11.9h-12.8l-4.6,11.9h3c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5H694v-1.6h3.8
			l13.7-35.1h2.3l14,35.1h2.1c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5H718.3z M711.2,880.2l-5.7,14.8H717L711.2,880.2z"/>
		<path class="st6" d="M759.2,873.6h12.5v1.6h-4.9v34.8l-2.8,0.6l-24-30.2v28.3h3.6c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5h-12.5
			v-1.6h4.9v-33.5h-4.9v-1.6h8.5l23.2,29v-27.4h-5.2V873.6z"/>
		<path class="st6" d="M781.3,910.2v-1.6h5.8v-33.5h-3.3c-3.1,0.2-5.4,2.4-6.7,6.4l-1,4.1h-1.7l0.3-12H805l0.3,12h-1.7l-1-4.1
			c0-0.1-0.1-0.2-0.1-0.4c-1.1-4-3.3-6-6.6-6h-3.5v33.5h4.2c0.2,0,0.4,0,0.6,0.1c0.7,0.1,1,0.6,1,1.5H781.3z"/>
		<path class="st6" d="M834.5,907c-2.6,2.5-6.2,3.8-10.9,3.8c-4,0-7.6-1-10.7-3.1c0,0.9,0,1.4-0.1,1.8c-0.2,0.6-0.7,0.9-1.7,0.9
			v-12.6h1.8c0.7,7.5,4.2,11.3,10.4,11.4c1.6,0,3-0.3,4.3-0.9c2.8-1.3,4.2-3.3,4.2-6.2c0-1.1-0.3-2.1-0.8-3.1c-1-1.7-3.3-3.3-7-4.9
			c-4-1.7-6.3-2.7-7-3.1c-3.8-2.2-5.7-4.9-5.7-8.4c0-2.3,0.8-4.3,2.4-6c2.4-2.4,5.9-3.7,10.3-3.7c3.6,0,6.9,0.8,9.8,2.4
			c0-0.5,0-0.9,0.1-1.2c0.2-0.6,0.7-0.9,1.7-0.9V884h-1.8c0-2.3-0.5-4.2-1.7-5.8c-1.8-2.3-4.4-3.5-7.8-3.5c-1.4,0-2.6,0.2-3.8,0.7
			c-2.6,1.1-4,3-4,5.7c0,1,0.2,2,0.7,2.9c0.9,1.6,3.2,3.2,6.8,4.8c4,1.8,6.4,2.8,7.1,3.2c3.9,2.2,5.9,5.1,5.9,8.7
			C837.1,903.1,836.2,905.3,834.5,907z"/>
	</g>
	<g>
		<path class="st6" d="M96.3,756.2h25.9v33.9c-2.4,2.4-5.2,4.7-8.3,6.7c-3.1,2-6.4,3.7-9.9,5.2c-3.5,1.4-7.1,2.5-10.8,3.3
			c-3.7,0.8-7.4,1.2-11.1,1.2c-4.9,0-9.7-0.6-14.2-1.8c-4.6-1.2-8.8-3-12.8-5.2c-4-2.2-7.6-5-10.8-8.2c-3.2-3.2-6-6.8-8.4-10.7
			c-2.3-4-4.2-8.3-5.4-12.9c-1.3-4.6-1.9-9.5-1.9-14.5c0-4.9,0.6-9.7,1.9-14.2c1.3-4.5,3.1-8.8,5.4-12.8c2.3-4,5.1-7.6,8.4-10.8
			c3.2-3.3,6.9-6.1,10.8-8.4c4-2.3,8.3-4.1,12.8-5.4c4.6-1.3,9.3-1.9,14.2-1.9c7.4,0,14.4,1.4,20.9,4.1c6.5,2.7,12.2,6.5,17.1,11.4
			l-4.1,3.8c-4.4-4.4-9.4-7.8-15.2-10.3c-5.7-2.5-11.9-3.7-18.6-3.7c-4.4,0-8.6,0.6-12.7,1.7c-4.1,1.1-7.9,2.8-11.4,4.8
			c-3.5,2.1-6.8,4.6-9.7,7.5c-2.9,2.9-5.4,6.2-7.5,9.8c-2.1,3.6-3.7,7.4-4.8,11.5c-1.1,4.1-1.7,8.4-1.7,12.8
			c0,6.6,1.3,12.9,3.8,18.7c2.5,5.8,5.9,10.9,10.3,15.3c4.3,4.3,9.4,7.8,15.2,10.3c5.8,2.5,12,3.8,18.6,3.8c3.1,0,6.3-0.3,9.4-0.9
			c3.1-0.6,6.2-1.5,9.1-2.7c2.9-1.2,5.7-2.6,8.4-4.2c2.7-1.6,5.1-3.4,7.3-5.4v-26.8h-20V756.2z"/>
		<g>
			<path class="st6" d="M216.9,762.3c3.6-0.7,6.9-1.9,9.9-3.6c3-1.7,5.5-3.8,7.7-6.3c2.1-2.5,3.8-5.5,5-8.8
				c1.2-3.3,1.8-6.9,1.8-10.9c0-4.6-0.8-8.7-2.4-12.5c-1.6-3.7-3.8-6.9-6.6-9.6c-2.8-2.6-6.2-4.7-10-6.1c-1.2-0.4-2.4-0.8-3.6-1.1
				c-1-0.2-2-0.4-3-0.6c-2-0.3-4-0.5-6.1-0.5h-2.3h-6h-33.9v37.5v6.6v9.8v6.6v41.2h5.8V763h37.5l25.9,41.1h6.9L216.9,762.3z
				 M209.7,757.7h-36.6v-1.2v-6.6v-9.8v-6.6v-25.8h23.3h6h6.9c0.6,0,1.2,0,1.8,0.1c1.8,0.1,3.6,0.4,5.3,0.8c1.1,0.3,2.2,0.6,3.2,1
				c3.2,1.2,5.9,2.9,8.2,5.1c2.3,2.2,4.1,4.8,5.5,7.9c1.3,3.1,2,6.5,2,10.2s-0.6,7.1-1.9,10.2c-1.3,3.1-3.1,5.7-5.3,7.9
				c-2.3,2.2-5,3.9-8.1,5C216.8,757.1,213.4,757.7,209.7,757.7z"/>
		</g>
		<path class="st6" d="M349.1,702.3h5.8v62.3c0,6.2-1,11.8-3.1,16.9c-2.1,5.1-4.9,9.4-8.5,13.1c-3.6,3.6-7.9,6.4-12.8,8.4
			c-4.9,2-10.2,3-15.9,3c-5.7,0-11-1-15.9-3c-4.9-2-9.1-4.8-12.8-8.4c-3.6-3.6-6.5-8-8.5-13c-2.1-5.1-3.1-10.7-3.1-17v-62.3h5.7
			v62.1c0,4.9,0.8,9.5,2.3,13.9c1.5,4.4,3.8,8.2,6.7,11.5c2.9,3.3,6.6,5.9,10.8,7.9c4.3,1.9,9.2,2.9,14.7,2.9
			c5.3,0,10.1-0.9,14.4-2.8c4.3-1.9,7.9-4.5,10.9-7.7c3-3.2,5.3-7,6.9-11.4c1.6-4.4,2.4-9,2.4-13.9V702.3z"/>
		<path class="st6" d="M403,765.8v38.3h-5.8V702.4h40.2c4.6,0,8.9,0.8,12.8,2.4c3.9,1.6,7.2,3.8,10,6.6c2.8,2.8,5,6.2,6.6,10.1
			c1.6,3.9,2.4,8.1,2.4,12.7c0,4.6-0.8,8.8-2.4,12.7c-1.6,3.9-3.8,7.2-6.5,10c-2.8,2.8-6.1,5-10,6.6c-3.9,1.6-8.1,2.4-12.7,2.4H403z
			 M437.6,760.6c3.7,0,7.2-0.7,10.3-2c3.1-1.3,5.8-3.2,8.1-5.6c2.3-2.4,4-5.1,5.3-8.3c1.3-3.2,1.9-6.7,1.9-10.4s-0.7-7.2-2-10.5
			c-1.3-3.2-3.1-6-5.5-8.4c-2.3-2.4-5.1-4.2-8.2-5.6c-3.2-1.4-6.6-2.1-10.4-2.1H403v52.9H437.6z"/>
		<g>
			<path class="st6" d="M605.8,739c-1.3-4.5-3.1-8.7-5.4-12.6c-2.3-3.9-5.1-7.5-8.4-10.7c-3.3-3.2-6.9-6-10.9-8.2
				c-4-2.3-8.3-4-12.9-5.3c-4.6-1.2-9.3-1.9-14.3-1.9c-4.9,0-9.7,0.6-14.2,1.9c-4.6,1.2-8.8,3-12.8,5.3c-4,2.3-7.6,5-10.8,8.2
				c-2.9,2.9-5.5,6.1-7.7,9.6c-0.2,0.4-0.5,0.7-0.7,1.1c-2,3.3-3.6,6.9-4.8,10.7c-0.2,0.6-0.4,1.3-0.6,1.9c-0.7,2.6-1.2,5.2-1.5,7.9
				c-0.2,2-0.4,4.1-0.4,6.2c0,0.1,0,0.3,0,0.4c0,4.7,0.7,9.3,1.9,13.7c1.3,4.5,3.1,8.7,5.4,12.6c2.3,3.9,5.1,7.4,8.4,10.6
				c3.2,3.2,6.9,5.9,10.8,8.2c4,2.3,8.3,4,12.8,5.3c4.6,1.2,9.3,1.9,14.2,1.9c4.9,0,9.7-0.6,14.3-1.9c4.6-1.2,8.9-3,12.9-5.3
				c4-2.3,7.6-5,10.9-8.2c3.3-3.2,6.1-6.7,8.4-10.6c2.3-3.9,4.2-8.1,5.4-12.6c1.3-4.5,1.9-9.2,1.9-14.1
				C607.7,748.2,607,743.5,605.8,739z M600.2,765.9c-1.1,4.1-2.8,7.8-4.9,11.3c-0.4,0.7-0.8,1.3-1.3,2c-0.7,1.1-1.5,2.2-2.3,3.2
				c-1.2,1.5-2.5,3-3.9,4.4c-2.9,2.9-6.2,5.3-9.7,7.4c-3.6,2-7.4,3.6-11.5,4.7c-4.1,1.1-8.3,1.6-12.7,1.6c-6.6,0-12.8-1.2-18.6-3.7
				c-5.8-2.4-10.9-5.8-15.2-10.1c-4.3-4.3-7.8-9.3-10.3-15c-2.5-5.8-3.8-12-3.8-18.6c0-1.9,0.1-3.8,0.3-5.7c0.3-2.7,0.8-5.3,1.6-7.9
				c0.5-1.7,1.1-3.5,1.9-5.1c1.8-4.1,4-7.8,6.7-11.1c1.1-1.4,2.3-2.7,3.6-4c0,0,0,0,0.1-0.1c4.3-4.3,9.4-7.6,15.2-10
				c5.8-2.4,12-3.7,18.6-3.7c6.6,0,12.9,1.2,18.7,3.7s10.9,5.8,15.3,10.1c4.3,4.3,7.8,9.3,10.3,15.1c2.5,5.8,3.8,12,3.8,18.7
				C601.9,757.6,601.4,761.9,600.2,765.9z"/>
		</g>
	</g>
	<g>
		<g>
			<path class="st6" d="M818,804.1h-4.6l-72.5-90.9v90.9h-5.8V702.4h4.3l72.8,91.2v-91.2h5.8V804.1z"/>
			<path class="st6" d="M818,702.4v101.7h-4.6l-72.5-90.9v90.9h-5.8V702.4h4.3l72.8,91.2v-91.2H818 M820,700.4h-2h-5.8h-2v2v85.5
				L741,701.1l-0.6-0.8h-1h-4.3h-2v2v101.7v2h2h5.8h2v-2v-85.2l69,86.4l0.6,0.8h1h4.6h2v-2V702.4V700.4L820,700.4z"/>
		</g>
		<g>
			<path class="st6" d="M925.5,776.5h-57.7L856,804.1h-6.2l44-101.7h6l44,101.7h-6.2L925.5,776.5z M870.2,771.2h53L897,710.4
				l-0.2-0.7l-0.2,0.7L870.2,771.2z"/>
			<path class="st6" d="M899.7,702.4l44,101.7h-6.2l-12-27.6h-57.7L856,804.1h-6.2l44-101.7H899.7 M870.2,771.2h53L897,710.4
				l-0.2-0.7l-0.2,0.7L870.2,771.2 M901,700.4h-1.3h-6h-1.3l-0.5,1.2l-44,101.7l-1.2,2.8h3h6.2h1.3l0.5-1.2l11.4-26.4h55l11.4,26.4
				l0.5,1.2h1.3h6.2h3l-1.2-2.8l-44-101.7L901,700.4L901,700.4z M873.2,769.2l23.5-54.3l23.4,54.3H873.2L873.2,769.2z"/>
		</g>
		<g>
			<g>
				<path class="st6" d="M1025.1,762.3c3.6-0.7,6.9-1.9,9.9-3.6c3-1.7,5.5-3.8,7.7-6.3c2.1-2.5,3.8-5.5,5-8.8
					c1.2-3.3,1.8-6.9,1.8-10.9c0-4.6-0.8-8.7-2.4-12.5c-1.6-3.7-3.8-6.9-6.6-9.6c-2.8-2.6-6.2-4.7-10-6.1c-1.2-0.4-2.4-0.8-3.6-1.1
					c-1-0.2-2-0.4-3-0.6c-2-0.3-4-0.5-6.1-0.5h-2.3h-6h-33.9v37.5v6.6v9.8v6.6v41.2h5.8V763h37.5l25.9,41.1h6.9L1025.1,762.3z
					 M1017.9,757.7h-36.6v-1.2v-6.6v-9.8v-6.6v-25.8h23.3h6h6.9c0.6,0,1.2,0,1.8,0.1c1.8,0.1,3.6,0.4,5.3,0.8c1.1,0.3,2.2,0.6,3.2,1
					c3.2,1.2,5.9,2.9,8.2,5.1c2.3,2.2,4.1,4.8,5.5,7.9c1.3,3.1,2,6.5,2,10.2s-0.6,7.1-1.9,10.2c-1.3,3.1-3.1,5.7-5.3,7.9
					c-2.3,2.2-5,3.9-8.1,5C1025.1,757.1,1021.6,757.7,1017.9,757.7z"/>
				<path class="st6" d="M1017.7,702.4c2.1,0,4.2,0.2,6.1,0.5c1,0.2,2,0.4,3,0.6c1.2,0.3,2.4,0.7,3.6,1.1c3.9,1.4,7.2,3.5,10,6.1
					c2.8,2.6,5,5.8,6.6,9.6c1.6,3.7,2.4,7.9,2.4,12.5c0,3.9-0.6,7.6-1.8,10.9c-1.2,3.3-2.8,6.2-5,8.8c-2.1,2.5-4.7,4.6-7.7,6.3
					c-3,1.7-6.3,2.9-9.9,3.6l26.4,41.8h-6.9l-25.9-41.1h-37.5v41.1h-5.8v-41.2v-6.6v-9.8v-6.6v-37.5h33.9h6H1017.7 M981.3,757.7
					h36.6c3.7,0,7.2-0.6,10.3-1.8c3.1-1.2,5.8-2.9,8.1-5c2.3-2.2,4.1-4.8,5.3-7.9c1.3-3.1,1.9-6.5,1.9-10.2s-0.7-7.2-2-10.2
					c-1.3-3.1-3.1-5.7-5.5-7.9c-2.3-2.2-5.1-3.9-8.2-5.1c-1-0.4-2.1-0.7-3.2-1c-1.7-0.4-3.5-0.7-5.3-0.8c-0.6,0-1.2-0.1-1.8-0.1
					h-6.9h-6h-23.3v25.8v6.6v9.8v6.6V757.7 M1017.7,700.4h-2.3h-6h-33.9h-2v2v37.5v6.6v9.8v6.6v41.2v2h2h5.8h2v-2V765h34.4
					l25.3,40.2l0.6,0.9h1.1h6.9h3.6l-1.9-3.1l-24.9-39.4c2.8-0.8,5.3-1.8,7.7-3.1c3.2-1.8,5.9-4.1,8.2-6.8c2.3-2.7,4.1-5.9,5.3-9.4
					c1.2-3.5,1.9-7.4,1.9-11.5c0-4.8-0.8-9.3-2.5-13.3c-1.7-4-4-7.4-7.1-10.3c-3-2.8-6.6-5-10.7-6.5c-1.2-0.4-2.5-0.8-3.8-1.2
					c-1-0.3-2.1-0.5-3.2-0.6C1022.1,700.6,1019.9,700.4,1017.7,700.4L1017.7,700.4z M983.3,709.7h21.3h6h6.9c0.5,0,1.1,0,1.7,0.1
					c1.7,0.1,3.4,0.3,4.9,0.7c1.1,0.3,2.1,0.6,3,0.9c2.9,1.1,5.5,2.7,7.6,4.7c2.1,2,3.8,4.4,5,7.3c1.2,2.8,1.8,6,1.8,9.5
					c0,3.5-0.6,6.6-1.8,9.4c-1.2,2.8-2.8,5.2-4.9,7.2c-2.1,2-4.6,3.5-7.4,4.6c-2.9,1.1-6.1,1.7-9.6,1.7h-34.6v-5.8v-9.8v-6.6V709.7
					L983.3,709.7z"/>
			</g>
		</g>
	</g>
	<polygon class="st6" points="716.9,710.6 716.9,700.7 612.9,804.7 612.9,804.7 622.9,804.7 622.9,804.7 	"/>
	<polygon class="st6" points="716.9,732.7 716.9,722.8 635.1,804.7 635.1,804.7 645,804.7 645,804.7 	"/>
</g>
</svg>
        </div>
        <div class="gate-brand-mid">
          <p class="gate-eyebrow">${t('gateBrandEyebrow')}</p>
          <h1>${t('gateBrandHeadline')}</h1>
          <p>${t('gateBrandBody')}</p>
        </div>
        <div class="gate-brand-footer">
          <span>&copy; ${new Date().getFullYear()} Grupo NAR</span>
          <a href="#" onclick="return false;">${t('gateBrandPrivacy')}</a>
        </div>
      </div>
      <div class="gate-panel">
        <div class="gate-panel-inner">${panelInnerHtml}</div>
      </div>
    </div>
  `;
  return wrap;
}

function wirePasswordToggle(wrap, inputId, toggleId){
  const input = wrap.querySelector('#'+inputId);
  const btn = wrap.querySelector('#'+toggleId);
  btn.onclick = () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? t('showPassword') : t('hidePassword');
  };
}

function renderLogin(body){
  if(authView === 'register'){ renderRegister(body); return; }
  if(authView === 'forgot'){ renderForgotPassword(body); return; }
  if(authView === 'totp'){ renderTotp(body); return; }

  const wrap = buildGateShell(`
    <p class="gate-eyebrow-small">${t('gateWelcomeBack')}</p>
    <div class="gate-title">${t('loginTitle')}</div>
    <div class="gate-sub">${t('loginGateSub')}</div>
    <div class="gate-error">${escapeHtml(loginError)}</div>
    ${registerSuccess ? `<div class="field-hint" style="color:var(--jade); margin-bottom:8px;">${escapeHtml(registerSuccess)}</div>` : ''}
    <label class="gate-field-label" for="login-email">${t('emailLabel')}</label>
    <input type="email" id="login-email" placeholder="${t('loginEmailPh')}" autocomplete="username">
    <label class="gate-field-label" for="login-password">${t('passwordLabel')}</label>
    <div class="pw-wrap">
      <input type="password" id="login-password" placeholder="${t('loginPasswordPh')}" autocomplete="current-password">
      <button type="button" class="pw-toggle" id="login-pw-toggle">${t('showPassword')}</button>
    </div>
    <div class="field-hint" style="text-align:right; margin:-6px 0 16px;"><a href="#" id="go-forgot">${t('forgotPasswordLink')}</a></div>
    <button class="btn primary" id="login-submit" ${loginLoading ? 'disabled' : ''}>${loginLoading ? t('loginSubmitting') : t('loginSubmit')}</button>
    <div class="field-hint" style="text-align:center; margin-top:16px;">${t('loginNoAccount')} <a href="#" id="go-register">${t('loginCreateAccount')}</a></div>
  `);
  body.appendChild(wrap);
  const submit = async () => {
    const email = wrap.querySelector('#login-email').value.trim();
    const password = wrap.querySelector('#login-password').value;
    if(!email || !password){ loginError = t('loginErrFields'); render(); return; }
    loginLoading = true; loginError=''; render();
    try{
      const result = await apiFetch('/api/auth/login', {method:'POST', body: JSON.stringify({email, password, lang})});
      loginLoading = false;
      if(result.twoFactor){
        pendingTotp = { method: result.method, qrCode: result.qrCode, secret: result.secret, setupMode: result.method === 'choose' };
        totpCode = ''; totpError = '';
        authView = 'totp';
        render();
        return;
      }
      currentUser = result;
      authenticated = true;
      registerSuccess = '';
      mainTab = (result.role === 'buyer' || result.role === 'seller') ? 'portal' : 'admin';
      await loadData();
    }catch(e){
      loginLoading = false;
      loginError = e.message === 'Failed to fetch' ? t('loginErrConnection') : e.message;
      render();
    }
  };
  wrap.querySelector('#login-submit').onclick = submit;
  wrap.querySelector('#login-password').onkeydown = (e) => { if(e.key==='Enter') submit(); };
  wrap.querySelector('#go-register').onclick = (e) => { e.preventDefault(); authView='register'; loginError=''; render(); };
  wrap.querySelector('#go-forgot').onclick = (e) => { e.preventDefault(); authView='forgot'; loginError=''; forgotMessage=''; render(); };
  wirePasswordToggle(wrap, 'login-password', 'login-pw-toggle');
}

// Segundo paso obligatorio del login (ver POST /api/auth/login y
// /api/auth/totp en routes/auth.js) — pendingTotp.setup distingue entre
// "todavía no tiene 2FA, aquí está el QR para armarlo" y "ya lo tiene, solo
// pide el código". La cuenta y la contraseña ya quedaron validadas en este
// punto; lo único que falta es confirmar el código de la app.
function renderTotp(body){
  if(!pendingTotp){ authView='login'; render(); return; }
  if(pendingTotp.method === 'choose'){ renderTotpChoice(body); return; }
  const method = pendingTotp.method; // 'totp' | 'email'
  const showQr = method === 'totp';
  const intro = method === 'email' ? t('totpIntroEmailSent') : (pendingTotp.setupMode ? t('totpIntroSetup') : t('totpIntroVerify'));
  const wrap = buildGateShell(`
    <div class="gate-title">${t('totpTitle')}</div>
    <div class="gate-sub">${intro}</div>
    <div class="gate-error">${escapeHtml(totpError)}</div>
    ${showQr ? `
      <div style="text-align:center; margin-bottom:14px;" id="totp-qr-wrap">
        <img src="${pendingTotp.qrCode}" style="width:180px; height:180px;" alt="QR">
        <div class="field-hint" style="margin-top:6px;">${t('totpManualLabel')}</div>
        <code style="font-size:13px; letter-spacing:1px;">${escapeHtml(pendingTotp.secret)}</code>
      </div>
    ` : ''}
    <label class="gate-field-label" for="totp-code">${t('totpCodeLabel')}</label>
    <input type="text" id="totp-code" inputmode="numeric" autocomplete="one-time-code" placeholder="${t('totpCodePh')}" style="text-align:center; font-size:20px; letter-spacing:4px;" value="${escapeHtml(totpCode)}">
    <label style="display:flex; align-items:center; gap:8px; font-size:12.5px; margin:12px 0 0; cursor:pointer;">
      <input type="checkbox" id="totp-remember" ${totpRemember ? 'checked' : ''}> ${t('rememberDeviceLabel')}
    </label>
    <button class="btn primary" id="totp-submit" style="margin-top:14px;" ${totpLoading ? 'disabled' : ''}>${totpLoading ? t('loginSubmitting') : t('totpSubmit')}</button>
    <div class="field-hint" style="text-align:center; margin-top:12px;">
      ${method === 'email' ? `<a href="#" id="totp-resend">${totpEmailSending ? t('totpSending') : t('totpResendCode')}</a><br>` : ''}
      ${pendingTotp.setupMode ? `<a href="#" id="totp-change-method">${t('totpChangeMethod')}</a><br>` : ''}
      <a href="#" id="totp-back">${t('backToLogin')}</a>
    </div>
  `);
  body.appendChild(wrap);
  const codeInput = wrap.querySelector('#totp-code');
  codeInput.focus();
  const submit = async () => {
    const code = codeInput.value.trim();
    if(!code){ totpError = t('totpErrCode'); render(); return; }
    totpLoading = true; totpError=''; render();
    try{
      const remember = document.getElementById('totp-remember')?.checked;
      const user = await apiFetch('/api/auth/totp', { method:'POST', body: JSON.stringify({ code, method: pendingTotp.method === 'email' ? 'email' : 'totp', remember }) });
      pendingTotp = null;
      currentUser = user;
      authenticated = true;
      mainTab = (user.role === 'buyer' || user.role === 'seller') ? 'portal' : 'admin';
      totpLoading = false;
      await loadData();
    }catch(e){
      totpLoading = false;
      totpError = e.message;
      render();
    }
  };
  wrap.querySelector('#totp-submit').onclick = submit;
  wrap.querySelector('#totp-remember').onchange = (e) => { totpRemember = e.target.checked; };
  codeInput.onkeydown = (e) => { if(e.key==='Enter') submit(); };
  const resendBtn = wrap.querySelector('#totp-resend');
  if(resendBtn) resendBtn.onclick = async (e) => {
    e.preventDefault();
    if(totpEmailSending) return;
    totpEmailSending = true; totpError=''; render();
    try{
      await apiFetch('/api/auth/email-otp', { method:'POST', body: JSON.stringify({ lang }) });
    }catch(err){
      totpError = err.message;
    }
    totpEmailSending = false;
    render();
  };
  const changeMethodBtn = wrap.querySelector('#totp-change-method');
  if(changeMethodBtn) changeMethodBtn.onclick = (e) => {
    e.preventDefault();
    pendingTotp = { ...pendingTotp, method: 'choose' };
    totpError=''; totpCode='';
    render();
  };
  wrap.querySelector('#totp-back').onclick = async (e) => {
    e.preventDefault();
    pendingTotp = null; totpError=''; totpCode='';
    try{ await apiFetch('/api/auth/logout', { method:'POST' }); }catch(err){}
    authView='login'; render();
  };
}

// Pantalla inicial de "elige tu método" (solo la primera vez que alguien
// configura su 2FA, antes tenía el QR mostrado de entrada con un link
// chiquito para cambiar a correo — pedido explícito de hacerlo dos botones
// igual de visibles en vez de esconder la opción de correo).
function renderTotpChoice(body){
  const wrap = buildGateShell(`
    <div class="gate-title">${t('totpTitle')}</div>
    <div class="gate-sub">${t('totpChooseIntro')}</div>
    <div class="gate-error">${escapeHtml(totpError)}</div>
    <div style="display:flex; flex-direction:column; gap:10px; margin-top:6px;">
      <button class="btn primary" id="totp-choose-app" style="width:100%;">${t('totpChooseApp')}</button>
      <button class="btn primary" id="totp-choose-email" style="width:100%;" ${totpEmailSending ? 'disabled' : ''}>${totpEmailSending ? t('totpSending') : t('totpChooseEmail')}</button>
    </div>
    <div class="field-hint" style="text-align:center; margin-top:14px;">
      <a href="#" id="totp-back">${t('backToLogin')}</a>
    </div>
  `);
  body.appendChild(wrap);
  wrap.querySelector('#totp-choose-app').onclick = () => {
    pendingTotp = { ...pendingTotp, method: 'totp' };
    totpCode=''; totpError='';
    render();
  };
  wrap.querySelector('#totp-choose-email').onclick = async () => {
    if(totpEmailSending) return;
    totpEmailSending = true; totpError=''; render();
    try{
      await apiFetch('/api/auth/email-otp', { method:'POST', body: JSON.stringify({ lang }) });
      pendingTotp = { ...pendingTotp, method: 'email' };
      totpCode = '';
    }catch(err){
      totpError = err.message;
    }
    totpEmailSending = false;
    render();
  };
  wrap.querySelector('#totp-back').onclick = async (e) => {
    e.preventDefault();
    pendingTotp = null; totpError=''; totpCode='';
    try{ await apiFetch('/api/auth/logout', { method:'POST' }); }catch(err){}
    authView='login'; render();
  };
}

function renderForgotPassword(body){
  const wrap = buildGateShell(`
    <div class="gate-title">${t('forgotPasswordTitle')}</div>
    <div class="gate-sub">${t('forgotPasswordSub')}</div>
    ${forgotMessage ? `<div class="field-hint" style="color:var(--jade); margin-bottom:8px;">${escapeHtml(forgotMessage)}</div>` : ''}
    <label class="gate-field-label" for="forgot-email">${t('emailLabel')}</label>
    <input type="email" id="forgot-email" placeholder="${t('loginEmailPh')}" autocomplete="username">
    <button class="btn primary" id="forgot-submit" ${forgotLoading ? 'disabled' : ''}>${forgotLoading ? t('loginSubmitting') : t('forgotPasswordSubmit')}</button>
    <div class="field-hint" style="text-align:center; margin-top:16px;"><a href="#" id="go-login">${t('backToLogin')}</a></div>
  `);
  body.appendChild(wrap);
  wrap.querySelector('#forgot-submit').onclick = async () => {
    const email = wrap.querySelector('#forgot-email').value.trim();
    if(!email) return;
    forgotLoading = true; render();
    try{
      await apiFetch('/api/auth/forgot-password', { method:'POST', body: JSON.stringify({ email }) });
      forgotMessage = t('forgotPasswordSent');
    }catch(e){
      forgotMessage = e.message;
    }
    forgotLoading = false;
    render();
  };
  wrap.querySelector('#go-login').onclick = (e) => { e.preventDefault(); authView='login'; forgotMessage=''; render(); };
}

function renderRegister(body){
  const wrap = buildGateShell(`
    <div class="gate-title">${t('registerTitle')}</div>
    <div class="gate-sub">${t('registerSub')}</div>
    <div class="gate-error">${escapeHtml(registerError)}</div>
    <label class="gate-field-label" for="reg-name">${t('name')}</label>
    <input type="text" id="reg-name" placeholder="${t('registerNamePh')}" autocomplete="name">
    <label class="gate-field-label" for="reg-email">${t('emailLabel')}</label>
    <input type="email" id="reg-email" placeholder="${t('registerEmailPh')}" autocomplete="username">
    <label class="gate-field-label" for="reg-password">${t('passwordLabel')}</label>
    <div class="pw-wrap">
      <input type="password" id="reg-password" placeholder="${t('registerPasswordPh')}" autocomplete="new-password">
      <button type="button" class="pw-toggle" id="reg-pw-toggle">${t('showPassword')}</button>
    </div>
    <select id="reg-role">
      <option value="agent">${t('registerRoleAgent')}</option>
      <option value="external_lawyer">${t('registerRoleExternalLawyer')}</option>
      <option value="lawyer">${t('registerRoleLawyer')}</option>
    </select>
    <select id="reg-agency">
      <option value="">${t('registerAgencyPlaceholderSelect')}</option>
      ${AGENCIES.map(a => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('')}
      <option value="Otro">${t('registerAgencyOther')}</option>
    </select>
    <input type="text" id="reg-agency-other" placeholder="${t('registerAgencyOtherPh')}" style="display:none;">
    <button class="btn primary" id="register-submit" ${registerLoading ? 'disabled' : ''}>${registerLoading ? t('registerSubmitting') : t('registerSubmit')}</button>
    <div class="field-hint" style="text-align:center; margin-top:16px;"><a href="#" id="go-login">${t('registerHaveAccount')}</a></div>
  `);
  body.appendChild(wrap);
  wirePasswordToggle(wrap, 'reg-password', 'reg-pw-toggle');
  const agencySelect = wrap.querySelector('#reg-agency');
  const agencyOtherInput = wrap.querySelector('#reg-agency-other');
  const roleSelect = wrap.querySelector('#reg-role');
  function syncAgencyVisibility(){
    const isAgent = roleSelect.value === 'agent';
    agencySelect.style.display = isAgent ? '' : 'none';
    agencyOtherInput.style.display = (isAgent && agencySelect.value === 'Otro') ? '' : 'none';
  }
  syncAgencyVisibility();
  roleSelect.onchange = syncAgencyVisibility;
  agencySelect.onchange = syncAgencyVisibility;
  wrap.querySelector('#go-login').onclick = (e) => { e.preventDefault(); authView='login'; registerError=''; render(); };
  wrap.querySelector('#register-submit').onclick = async () => {
    const name = wrap.querySelector('#reg-name').value.trim();
    const email = wrap.querySelector('#reg-email').value.trim();
    const password = wrap.querySelector('#reg-password').value;
    const role = roleSelect.value;
    const agency = agencySelect.value;
    const agencyOther = agencyOtherInput.value.trim();
    if(!name || !email || !password){ registerError = t('registerErrFields'); render(); return; }
    if(role === 'agent' && (!agency || (agency==='Otro' && !agencyOther))){ registerError = t('registerErrAgency'); render(); return; }
    registerLoading = true; registerError=''; render();
    try{
      const result = await apiFetch('/api/auth/register', { method:'POST', body: JSON.stringify({name, email, password, role, agency, agencyOther}) });
      registerLoading = false;
      authView = 'login';
      registerSuccess = result.message;
      render();
    }catch(e){
      registerLoading = false;
      registerError = e.message;
      render();
    }
  };
}

async function logout(){
  try{ await apiFetch('/api/auth/logout', {method:'POST'}); }catch(e){}
  authenticated = false;
  currentUser = null;
  render();
}

document.getElementById('mainTabs').addEventListener('click', e=>{
  const btn = e.target.closest('.tab-btn');
  if(!btn || btn.id === 'header-logout') return;
  mainTab = btn.dataset.tab;
  render();
});
document.getElementById('header-logout').addEventListener('click', logout);
document.getElementById('menu-toggle').addEventListener('click', () => {
  setSidebarOpen(!document.getElementById('sidebar').classList.contains('open'));
});
document.getElementById('sidebar-scrim').addEventListener('click', () => setSidebarOpen(false));

// Círculo con foto (si el usuario subió una) o iniciales — `user` puede ser
// currentUser ({id, avatarUrl}) o un agente de una operación ({userId,
