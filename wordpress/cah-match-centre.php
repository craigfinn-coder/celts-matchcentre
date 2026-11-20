<?php
/**
 * CAH – Match Centre (native)
 *
 * Shortcode [cah_match_centre] replaces the old iframe on /celtic-match-centre/.
 * - Prints the match centre as real HTML (fetched from the Vercel engine), so Google can read it
 *   and it sits inside the WordPress page with the site's ads around it.
 * - Loads mc.js from the engine, which keeps the score live in the browser.
 * - Adds a "From CeltsAreHere" block of recent articles about the opponent.
 * WordPress never does live work: it fetches the fragment at most once a minute and keeps
 * the last good copy if the engine is unreachable.
 */
if (!defined('ABSPATH')) { exit; }
if (!defined('CAH_MC_ENGINE')) {
    define('CAH_MC_ENGINE', 'https://celts-matchcentre-contact-37329015.vercel.app');
}

function cah_mc_fragment() {
    $cached = get_transient('cah_mc_fragment_v1');
    if (is_array($cached)) {
        return $cached;
    }
    $out = array('html' => '', 'opp' => '');
    $r = wp_remote_get(CAH_MC_ENGINE . '/api/fragment', array('timeout' => 4, 'redirection' => 0));
    if (!is_wp_error($r) && 200 === wp_remote_retrieve_response_code($r)) {
        $body = wp_remote_retrieve_body($r);
        if (strlen($body) > 500) {
            $out = array('html' => $body, 'opp' => sanitize_text_field(rawurldecode((string) wp_remote_retrieve_header($r, 'x-mc-opponent'))));
            update_option('cah_mc_fragment_last', $out, false);
        }
    }
    if ('' === $out['html']) {
        $last = get_option('cah_mc_fragment_last');
        if (is_array($last)) {
            $out = $last;
        }
    }
    set_transient('cah_mc_fragment_v1', $out, 60);
    return $out;
}

function cah_mc_related_links($opp) {
    $opp = trim(preg_replace('/\bSt\.\s/', 'St ', (string) $opp));
    if ('' === $opp) {
        return '';
    }
    $key = 'cah_mc_links_' . md5($opp);
    $html = get_transient($key);
    if (false !== $html) {
        return $html;
    }
    $q = new WP_Query(array(
        'post_type'           => 'post',
        'post_status'         => 'publish',
        'posts_per_page'      => 4,
        's'                   => $opp,
        'date_query'          => array(array('after' => '10 days ago')),
        'orderby'             => 'date',
        'order'               => 'DESC',
        'no_found_rows'       => true,
        'ignore_sticky_posts' => true,
    ));
    $html = '';
    if ($q->have_posts()) {
        $items = '';
        foreach ($q->posts as $p) {
            $items .= '<a href="' . esc_url(get_permalink($p)) . '"><span class="k">' . esc_html(get_the_date('j M', $p)) . '</span><span class="t">' . esc_html(get_the_title($p)) . '</span></a>';
        }
        $html = '<div class="cahmc cahmc-links"><section class="card links"><h2>From CeltsAreHere</h2>' . $items . '</section></div>';
    }
    wp_reset_postdata();
    set_transient($key, $html, 15 * MINUTE_IN_SECONDS);
    return $html;
}

add_shortcode('cah_match_centre', function () {
    $f = cah_mc_fragment();
    $engine = esc_url(CAH_MC_ENGINE);
    $out  = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;700;800;900&display=swap">';
    $out .= '<link rel="stylesheet" href="' . $engine . '/mc.css">';
    // The fragment is HTML built by our own engine (all data escaped there), so it is printed as is.
    $out .= '<div class="cahmc" data-mc data-api="' . esc_attr(CAH_MC_ENGINE) . '">'
          . ($f['html'] ? $f['html'] : '<p style="padding:20px">Loading the match centre…</p>')
          . '</div>';
    $out .= '<script type="module" src="' . $engine . '/mc.js"></script>';
    $out .= cah_mc_related_links($f['opp']);
    return $out;
});
